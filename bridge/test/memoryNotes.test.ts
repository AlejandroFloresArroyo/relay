import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryNotes, changeMemoryNote, memoryCharacters } from '../src/memoryNotes.ts';

test('memory notes use the full Hermes delimiter and ignore a leading UTF-8 BOM without losing a bare section character', () => {
  assert.deepEqual(memoryNotes('\uFEFF  Soy Ale § tengo dos máquinas. \n§\n\n§\n  Uso Relay.\n'), [
    { index: 0, text: 'Soy Ale § tengo dos máquinas.' }, { index: 2, text: 'Uso Relay.' },
  ]);
});

test('editing one exact memory note preserves every other byte and counts Unicode code points as Hermes does', () => {
  const raw = '\uFEFF Primera. \n§\n  Segunda.\n\n';
  assert.equal(changeMemoryNote(raw, { index: 0, previous: 'Primera.', content: 'Nueva 😀.' }, 100), '\uFEFFNueva 😀.\n§\n  Segunda.\n\n');
  assert.equal(memoryCharacters('😀\n§\ná'), 5);
  assert.equal(changeMemoryNote('😀\n§\ná', { index: 0, previous: '😀', content: '🦊' }, 5), '🦊\n§\ná');
  assert.throws(() => changeMemoryNote('😀\n§\ná', { index: 0, previous: '😀', content: '🦊🦊' }, 5), /limit/);
});

test('stale or fabricated note identity cannot change memory and a replacement cannot introduce another note', () => {
  const raw = 'First\n§\nSecond';
  assert.throws(() => changeMemoryNote(raw, { index: 1, previous: 'First', content: 'Changed' }, 100), /conflict/);
  assert.throws(() => changeMemoryNote(raw, { index: -1, previous: 'Second', content: 'Changed' }, 100), /conflict/);
  assert.throws(() => changeMemoryNote(raw, { index: 1, previous: 'Second', content: 'Changed\n§\nThird' }, 100), /invalid/);
  assert.throws(() => changeMemoryNote(raw, { index: 1, previous: 'Second', content: '  ' }, 100), /invalid/);
});

test('deleting an exact note preserves its siblings and can reduce existing memory that is already over limit', () => {
  assert.equal(changeMemoryNote('\uFEFF  First \n§\nSecond\n§\n  Third\n', { index: 1, previous: 'Second', content: null }, 1), '\uFEFF  First \n§\n  Third\n');
  assert.equal(changeMemoryNote('\uFEFFFirst\n§\n  Second\n', { index: 0, previous: 'First', content: null }, 100), '\uFEFF  Second\n');
  assert.equal(changeMemoryNote('Only', { index: 0, previous: 'Only', content: null }, 0), '');
});

test('memory whitespace matches Python rather than JavaScript, and lossy Unicode cannot be saved', () => {
  assert.deepEqual(memoryNotes('First\n§\n\u0085Second\u0085\n§\n\uFEFFThird\uFEFF'), [
    { index: 0, text: 'First' }, { index: 1, text: 'Second' }, { index: 2, text: '\uFEFFThird\uFEFF' },
  ]);
  assert.throws(() => changeMemoryNote('First', { index: 0, previous: 'First', content: '\uD800' }, 100), /invalid/);
});

test('Windows and classic Mac newlines follow Python file reading while edits retain sibling bytes and separators',()=>{
 const raw='\uFEFF First\r\nline \r\n§\r\n  Second\r\n';
 assert.deepEqual(memoryNotes(raw),[{index:0,text:'First\nline'},{index:1,text:'Second'}]);
 assert.equal(changeMemoryNote(raw,{index:0,previous:'First\nline',content:'Updated'},100),'\uFEFFUpdated\r\n§\r\n  Second\r\n');
 assert.equal(changeMemoryNote(raw,{index:1,previous:'Second',content:null},0),'\uFEFF First\r\nline ');
 assert.equal(memoryCharacters('😀\r\n§\r\ná'),5);
 assert.throws(()=>changeMemoryNote(raw,{index:0,previous:'First\nline',content:'New\r\n§\r\nInjected'},100),/invalid/);
 assert.deepEqual(memoryNotes('First\r§\rSecond'),[{index:0,text:'First'},{index:1,text:'Second'}]);
});
