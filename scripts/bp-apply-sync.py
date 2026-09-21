import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "authentik.root.settings")

import django  # noqa: E402

django.setup()

raw = open("/blueprints/custom/gw.yaml").read()

from authentik.blueprints.v1.importer import Importer  # noqa: E402

try:
    imp = Importer.from_string(raw)
    print("constructed via from_string")
except Exception as exc:  # noqa: BLE001
    print(f"from_string failed: {exc!r}")
    try:
        imp = Importer(raw)
        print("constructed via Importer(raw)")
    except Exception as exc2:  # noqa: BLE001
        print(f"Importer(raw) failed: {exc2!r}")
        raise SystemExit(1)

try:
    result = imp.validate()
    if isinstance(result, tuple):
        valid, logs = result
    else:
        valid, logs = bool(result), []
    print(f"valid: {valid}")
    for item in logs if isinstance(logs, list) else []:
        if isinstance(item, tuple):
            entry, msgs = item
            eid = entry.get("id") if isinstance(entry, dict) else entry
            if msgs:
                print(f"ENTRY {eid} -> {msgs}")
        else:
            print(f"LOG: {item}")
except Exception as exc:  # noqa: BLE001
    import traceback

    traceback.print_exc()
    valid = False

if valid:
    res = imp.apply()
    print(f"apply result: {res}")
else:
    print("INVALID — not applying")
