import json
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "authentik.root.settings")

import django

django.setup()

from authentik.blueprints.v1.tasks import apply_blueprint

result = apply_blueprint("custom/gw.yaml")
print("RESULT:", json.dumps(result, default=str)[:1500])
