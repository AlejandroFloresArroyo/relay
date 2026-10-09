"""Bounded pure YAML metadata transform. Never import Hermes or initialize directories."""
import json
import sys
import yaml
from yaml.tokens import AliasToken, AnchorToken


def parse(raw):
    if len(raw.encode('utf-8')) > 1_048_576:
        raise ValueError()
    # Reject alias graphs, duplicate keys and deep documents before constructing values.
    if any(isinstance(token, (AliasToken, AnchorToken)) for token in yaml.scan(raw)):
        raise ValueError()
    node = yaml.compose(raw, Loader=yaml.SafeLoader)
    count = 0

    def check(value, depth=0):
        nonlocal count
        count += 1
        if count > 20000 or depth > 30:
            raise ValueError()
        if isinstance(value, yaml.MappingNode):
            keys = []
            for key, child in value.value:
                if not isinstance(key, yaml.ScalarNode) or key.tag != 'tag:yaml.org,2002:str' or key.value in keys:
                    raise ValueError()
                keys.append(key.value)
                check(child, depth + 1)
        elif isinstance(value, yaml.SequenceNode):
            for child in value.value:
                check(child, depth + 1)
    if node:
        check(node)
    value = yaml.safe_load(raw)
    if value is not None and not isinstance(value, dict):
        raise ValueError()
    return value or {}, node


def strings(value, scalar=False):
    if value is None:
        return []
    if isinstance(value, str):
        import ast
        value = ast.literal_eval(value) if value.strip().startswith('[') else ([value] if scalar else ast.literal_eval(value))
    if not isinstance(value, list) or not all(isinstance(s, str) for s in value):
        raise ValueError()
    return [name.strip() for name in value] if scalar else value


def edit(request):
    raw = request['raw']
    config, node = parse(raw)
    catalog = request['catalog']
    name = request['name']
    if request['enabled']:
        by_name = {entry['name']: entry for entry in catalog}
        requested_tools = set(by_name[name]['tools'])
        for disabled in strings((config.get('agent') or {}).get('disabled_toolsets'), scalar=True):
            if disabled == name or disabled not in by_name or requested_tools.intersection(by_name[disabled]['tools']):
                return {'error': 'global_restriction'}
    current = strings((config.get('platform_toolsets') or {}).get('api_server'))
    names = {entry['name'] for entry in catalog}
    # Platform composites are expanded by the canonical endpoint. Unknown composites cannot
    # safely be retained: they could silently re-enable a toolset the user just disabled.
    composites = {'hermes-' + s for s in ('cli telegram discord slack whatsapp signal bluebubbles email homeassistant mattermost matrix dingtalk feishu wecom wecom-callback weixin qqbot yuanbao webhook api-server cron').split()}
    mcp = set((config.get('mcp_servers') or {}).keys())
    passthrough = set(current) - names - composites
    if not passthrough <= (mcp | {'no_mcp', 'context_engine'}):
        return {'error': 'custom_toolsets'}
    selected = {entry['name'] for entry in catalog if entry['enabled']} | passthrough
    context = config.get('context') or {}
    if isinstance(context, dict) and str(context.get('engine') or 'compressor').strip().lower() != 'compressor':
        saved = (config.get('platform_toolsets') or {}).get('api_server')
        if saved is None or current:
            selected.add('context_engine')
    if request['enabled']:
        selected.add(name)
    else:
        selected.discard(name)
    updates = {'platform_toolsets': sorted(selected), 'known_builtin_toolsets': sorted(names), 'known_plugin_toolsets': sorted(names)}
    # Replace only api_server values; preserve every other byte, including other channels.
    edits = []
    root = dict((key.value, value) for key, value in node.value) if node else {}
    for section, value in updates.items():
        replacement = json.dumps(value, ensure_ascii=False)
        parent = root.get(section)
        if parent is None:
            edits.append((len(raw), len(raw), '\n' + section + ':\n  api_server: ' + replacement + '\n'))
        elif isinstance(parent, yaml.MappingNode) and not parent.flow_style:
            children = {key.value: child for key, child in parent.value}
            child = children.get('api_server')
            if child:
                # Replace through the node end, preserving following indentation/newline.
                end = child.end_mark.index
                suffix = '\n' + ' ' * child.end_mark.column if raw[child.start_mark.index:end].endswith('\n' + ' ' * child.end_mark.column) else ''
                edits.append((child.start_mark.index, end, replacement + suffix))
            else:
                start = parent.start_mark.index - parent.start_mark.column
                edits.append((start, start, ' ' * parent.start_mark.column + 'api_server: ' + replacement + '\n'))
        else:
            # Null and flow mappings are safe to replace at section scope; semantic preservation
            # is checked below for every value outside the three api_server leaves.
            existing = config.get(section) or {}
            if not isinstance(existing, dict):
                raise ValueError()
            existing = dict(existing, api_server=value)
            edits.append((parent.start_mark.index, parent.end_mark.index, json.dumps(existing, ensure_ascii=False)))
    changed = raw
    for start, end, replacement in sorted(edits, key=lambda entry: entry[0], reverse=True):
        changed = changed[:start] + replacement + changed[end:]
    after, _ = parse(changed)
    expected = dict(config)
    for section, value in updates.items():
        expected[section] = dict(config.get(section) or {}, api_server=value)
    if after != expected:
        raise ValueError()
    return {'raw': changed}


def skills(request):
    config, _ = parse(request['raw'])
    settings = config.get('skills') or {}
    disabled = set(strings(settings.get('disabled'), scalar=True)) | set(strings((settings.get('platform_disabled') or {}).get('api_server'), scalar=True))
    result = []
    limited = False
    for entry in request['files']:
        try:
            raw = entry['text'].replace('\r\n', '\n')
            if raw.startswith('---\n'):
                end = raw.find('\n---', 4)
                if end < 0:
                    raise ValueError()
                metadata, _ = parse(raw[4:end + 1])
            else:
                metadata = {}
            name = metadata.get('name', entry['name'])
            description = metadata.get('description', '')
            if not isinstance(name, str) or not name or len(name) > 200 or not isinstance(description, str):
                raise ValueError()
            result.append({'name': name, 'description': description[:1000], 'category': entry['category'],
                           'availability': 'disabled' if name in disabled and name not in ('hermes-agent',) else 'unknown'})
        except Exception:
            limited = True
    return {'skills': result, 'limited': limited}


try:
    request = json.loads(sys.stdin.read(4_000_001))
    result = edit(request) if request['operation'] == 'edit' else skills(request)
    print(json.dumps(result, ensure_ascii=False))
except Exception:
    print(json.dumps({'error': 'invalid_metadata'}))
