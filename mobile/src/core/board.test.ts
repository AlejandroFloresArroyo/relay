import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardTime, boardTitle } from './board.ts';

test('card hours read in 24 h, es-MX, uppercase and without am/pm', () => {
  assert.equal(boardTime(new Date(2026, 9, 5, 22, 20).getTime()), '5 OCT 22:20');
  assert.equal(boardTime(new Date(2026, 0, 12, 0, 5).getTime()), '12 ENE 00:05');
  assert.equal(boardTime(new Date(2026, 11, 31, 12, 0).getTime()), '31 DIC 12:00');
});

test('the Tablero caption counts visible cards and the new ones, and omits zero new', () => {
  assert.equal(boardTitle(7, 3, false), '7 TARJETAS · 3 NUEVAS');
  assert.equal(boardTitle(7, 1, false), '7 TARJETAS · 1 NUEVA');
  assert.equal(boardTitle(7, 0, false), '7 TARJETAS');
  assert.equal(boardTitle(1, 0, false), '1 TARJETA');
  assert.equal(boardTitle(7, 3, true), 'EDITANDO EL TABLERO');
});
