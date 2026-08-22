#!/usr/bin/env python3
import os
import pathlib
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit('usage: render-systemd-template.py SOURCE DESTINATION')

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
keys = ['AGENT_USER', 'AGENT_GROUP', 'AGENT_HOME', 'MISE_SHIMS', 'HERDR_BIN', 'HERDR_SESSION']
text = source.read_text()
for key in keys:
    try:
        value = os.environ[key]
    except KeyError as error:
        raise SystemExit(f'missing required render environment variable: {key}') from error
    text = text.replace(f'@{key}@', value)

unresolved = sorted(set(re.findall(r'@[A-Z0-9_]+@', text)))
if unresolved:
    raise SystemExit(f'unresolved systemd template placeholders: {", ".join(unresolved)}')

destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(text)
