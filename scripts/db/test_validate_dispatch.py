"""Deterministic dispatch validation; no subprocess or database access."""

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "validate_dispatch", Path(__file__).with_name("validate-dispatch.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DispatchTests(unittest.TestCase):
    def test_operation_contract(self):
        credentials = dict.fromkeys(
            ("SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN",
             "SUPABASE_PROJECT_ID"), "configured_placeholder"
        )
        cases = [
            ({"MODE": "migrate", "DRY_RUN": "true"}, None),
            ({"MODE": "migrate", "DRY_RUN": "false"}, "Standalone production SQL"),
            ({"MODE": "migrate"}, "Standalone production SQL"),
            ({"MODE": "history", "DRY_RUN": "false"}, None),
            ({"MODE": "unknown"}, "Unsupported"),
            ({"MODE": "repair", "STATUS": "applied", "VERSIONS": "20261116000000",
              "CONFIRMATION": "REPAIR PRODUCTION MIGRATION HISTORY"}, None),
            ({"MODE": "repair"}, "confirmation"),
            ({"MODE": "repair", "CONFIRMATION": "REPAIR PRODUCTION MIGRATION HISTORY",
              "STATUS": "invalid"}, "status"),
            ({"MODE": "repair", "CONFIRMATION": "REPAIR PRODUCTION MIGRATION HISTORY",
              "STATUS": "reverted", "VERSIONS": "invalid"}, "14-digit"),
        ]
        for request, error in cases:
            with self.subTest(request=request):
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        module.validate(credentials | request)
                else:
                    module.validate(credentials | request)

    def test_missing_connection_secret_is_named_without_values(self):
        for missing in ("SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD"):
            env = dict.fromkeys(
                ("SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD"), "private_placeholder"
            )
            del env[missing]
            with self.subTest(missing=missing):
                with self.assertRaises(ValueError) as caught:
                    module.validate(env | {"MODE": "history"})
                self.assertEqual(
                    str(caught.exception),
                    "Missing production environment secret(s): " + missing,
                )


if __name__ == "__main__":
    unittest.main()
