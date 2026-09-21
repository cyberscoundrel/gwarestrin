import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "authentik.root.settings")

import django

django.setup()

from django.contrib.auth import get_user_model

user_model = get_user_model()
u = user_model.objects.get(username="akadmin")
new_password = os.environ.get("AKADMIN_NEW_PASSWORD", "reset-pass-909")
u.set_password(new_password)
u.save()
print("akadmin password reset to:", new_password)
