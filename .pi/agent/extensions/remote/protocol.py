"""Shared wire identity; independent of transport and project operations."""
import re

PROTOCOL = "pi-remote-v1"
UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$")
