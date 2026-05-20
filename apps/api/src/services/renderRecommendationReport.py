#!/usr/bin/env python3
"""Render a NewLeaf recommendation report PDF from template data."""

import base64
import json
import re
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
REPORT_ROOT = BASE_DIR / "report-assets"
TEMPLATE_FILE = REPORT_ROOT / "templates" / "report-v3.html"
LOGO_FILE = REPORT_ROOT / "assets" / "logos" / "newleaf-logo.png"


def main(argv):
    if len(argv) != 3:
        print("Usage: renderRecommendationReport.py <input-json> <output-pdf>", file=sys.stderr)
        return 2

    input_json = Path(argv[1])
    output_pdf = Path(argv[2])
    if not input_json.exists():
        print(f"Input JSON not found: {input_json}", file=sys.stderr)
        return 2
    if not TEMPLATE_FILE.exists():
        print(f"Report template not found: {TEMPLATE_FILE}", file=sys.stderr)
        return 2

    try:
        import weasyprint
    except ImportError:
        print("WeasyPrint is not installed.", file=sys.stderr)
        return 3

    with input_json.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    html = fill_template(TEMPLATE_FILE, data, logo_data_uri())
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    weasyprint.HTML(string=html, base_url=str(TEMPLATE_FILE.parent)).write_pdf(str(output_pdf))
    return 0


def fill_template(template_file, data, logo_uri):
    html = template_file.read_text(encoding="utf-8")

    for key, value in data.items():
        html = html.replace(f"{{{{{key}}}}}", "" if value is None else str(value))

    if logo_uri:
        html = re.sub(
            r'<img\s+class="banner-logo"[^>]*>',
            f'<img class="banner-logo" src="{logo_uri}">',
            html,
        )

    for section in ["MACRO", "COMPANY", "ANALYST"]:
        if not data.get(f"HAS_{section}"):
            html = re.sub(
                rf"<!-- IF_{section} -->.*?<!-- /IF_{section} -->",
                "",
                html,
                flags=re.DOTALL,
            )

    return re.sub(r"{{[A-Z0-9_]+}}", "N/A", html)


def logo_data_uri():
    if not LOGO_FILE.exists():
        return ""
    return "data:image/png;base64," + base64.b64encode(LOGO_FILE.read_bytes()).decode("ascii")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
