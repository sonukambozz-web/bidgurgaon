import os
import sys
import json
import re
import urllib.request
import urllib.error
from html import unescape

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

def load_env():
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    return env

def get_notion_client():
    env = load_env()
    token = os.environ.get("NOTION_TOKEN") or env.get("NOTION_TOKEN", "")
    db_id = os.environ.get("NOTION_DATABASE_ID") or env.get("NOTION_DATABASE_ID", "3e1f53d79e58816db36ef8020661c37c")
    db_id = db_id.replace("-", "").split("?")[0].split("/")[-1]
    return token, db_id

def notion_api_request(endpoint, token, method="GET", payload=None):
    url = f"https://api.notion.com/v1/{endpoint}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
    }
    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def extract_prop_val(prop):
    if not prop:
        return None
    t = prop.get("type")
    if t == "title":
        return "".join(x.get("plain_text", "") for x in prop.get("title", [])).strip()
    elif t == "rich_text":
        return "".join(x.get("plain_text", "") for x in prop.get("rich_text", [])).strip()
    elif t == "select":
        return prop.get("select", {}).get("name") if prop.get("select") else None
    elif t == "multi_select":
        return [x.get("name") for x in prop.get("multi_select", [])]
    elif t == "number":
        return prop.get("number")
    elif t == "checkbox":
        return prop.get("checkbox", False)
    elif t == "date":
        return prop.get("date", {}).get("start") if prop.get("date") else None
    elif t == "status":
        return prop.get("status", {}).get("name") if prop.get("status") else None
    elif t == "url":
        return prop.get("url")
    return None

def fetch_all_notion_projects(db_id, token):
    url_endpoint = f"databases/{db_id}/query"
    has_more = True
    start_cursor = None
    all_pages = []

    while has_more:
        payload = {"page_size": 100}
        if start_cursor:
            payload["start_cursor"] = start_cursor
        res = notion_api_request(url_endpoint, token, method="POST", payload=payload)
        all_pages.extend(res.get("results", []))
        has_more = res.get("has_more", False)
        start_cursor = res.get("next_cursor")

    return all_pages

def slugify(text):
    text = unescape(str(text or "")).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text

def map_notion_to_project(page, existing_dev_slugs):
    props = page.get("properties", {})
    name = extract_prop_val(props.get("Name"))
    if not name:
        return None, None

    active = extract_prop_val(props.get("Active"))
    builder_raw = extract_prop_val(props.get("Builder")) or "Independent Developer"
    location = extract_prop_val(props.get("Location")) or "Gurugram"
    price = extract_prop_val(props.get("Price")) or ""
    area = extract_prop_val(props.get("Area")) or ""
    prop_type = extract_prop_val(props.get("Type")) or ""
    status = extract_prop_val(props.get("Status")) or "Under Construction"
    possession_raw = extract_prop_val(props.get("Possession")) or ""
    rera_reg = extract_prop_val(props.get("RERA Reg No")) or ""
    rera_cert = extract_prop_val(props.get("RERA Certificate URL")) or ""
    rera_details = extract_prop_val(props.get("RERA Details URL")) or ""
    cover_image = extract_prop_val(props.get("Cover Image URL")) or ""
    highlights = extract_prop_val(props.get("Highlights")) or []

    possession = possession_raw
    if "/" in possession_raw:
        parts = possession_raw.split("/")
        if len(parts) == 3 and len(parts[2]) == 4:
            possession = parts[2]

    builder_slug = slugify(builder_raw)
    if "dlf" in builder_slug:
        dev_id = "dlf-limited"
    elif "elan" in builder_slug:
        dev_id = "elan-group"
    elif "godrej" in builder_slug:
        dev_id = "godrej-properties"
    elif "m3m" in builder_slug:
        dev_id = "m3m-india"
    elif "signature" in builder_slug:
        dev_id = "signature-global"
    else:
        dev_id = builder_slug

    proj_id = slugify(name)
    summary = f"Premium {prop_type} by {builder_raw} in {location}."
    if highlights:
        summary += f" Key highlights: {', '.join(highlights[:3])}."

    project_data = {
        "id": proj_id,
        "name": name,
        "developerId": dev_id,
        "locality": location,
        "status": status,
        "possession": possession,
        "configs": prop_type or "Luxury Residences",
        "sizeRange": area,
        "priceRange": price,
        "rera": rera_reg,
        "reraCertificateUrl": rera_cert,
        "reraDetailsUrl": rera_details,
        "coverImage": cover_image,
        "summary": summary,
        "highlights": highlights,
        "activePartners": []
    }

    developer_info = None
    if dev_id not in existing_dev_slugs:
        words = [w for w in builder_raw.split() if w.lower() not in ["limited", "ltd", "pvt", "private", "llp", "corporation"]]
        logo = "".join(w[0].upper() for w in words[:2]) if words else "DEV"
        developer_info = {
            "rank": 0,
            "id": dev_id,
            "name": builder_raw,
            "rera": "Registered per project",
            "bidAmount": 0,
            "bidCycle": "month",
            "since": "",
            "logo": logo,
            "locality": location,
            "tagline": f"Leading real estate developer in Gurugram.",
            "projects": [proj_id]
        }

    return project_data, developer_info

def sync_projects(dry_run=True):
    token, db_id = get_notion_client()
    if not token:
        print("[ERROR] Notion token is missing.")
        return

    print("Fetching projects from Notion...")
    pages = fetch_all_notion_projects(db_id, token)
    print(f"Total projects fetched from Notion: {len(pages)}")

    data_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    existing_projects = {p["id"]: p for p in data.get("projects", [])}
    existing_devs = {d["id"]: d for d in data.get("developers", [])}
    existing_dev_slugs = set(existing_devs.keys())

    updated_count = 0
    added_count = 0
    new_devs = []

    print("\n" + "="*70)
    mode_text = "DRY RUN (Preview Only - No files modified)" if dry_run else "APPLYING CHANGES TO data.json & REGENERATING SITE"
    print(f"SYNC PREVIEW: {mode_text}")
    print("="*70)

    for page in pages:
        proj_data, new_dev = map_notion_to_project(page, existing_dev_slugs)
        if not proj_data:
            continue

        p_id = proj_data["id"]
        if p_id in existing_projects:
            print(f"[UPDATE] Project: '{proj_data['name']}' ({p_id})")
            print(f"         RERA: {proj_data['rera']} | Status: {proj_data['status']} | Price: {proj_data['priceRange']}")
            if not dry_run:
                for k, v in proj_data.items():
                    if v or k not in existing_projects[p_id]:
                        existing_projects[p_id][k] = v
            updated_count += 1
        else:
            print(f"[ADD]    New Project: '{proj_data['name']}' ({p_id}) -> Dev: {proj_data['developerId']}")
            print(f"         Locality: {proj_data['locality']} | RERA: {proj_data['rera']}")
            if not dry_run:
                existing_projects[p_id] = proj_data
            added_count += 1

        if new_dev and new_dev["id"] not in existing_dev_slugs:
            print(f"[NEW DEV] Adding Developer: '{new_dev['name']}' ({new_dev['id']})")
            if not dry_run:
                existing_devs[new_dev["id"]] = new_dev
            existing_dev_slugs.add(new_dev["id"])
            new_devs.append(new_dev)

    print("\n" + "-"*70)
    print(f"Summary: {added_count} new projects to add, {updated_count} projects to update, {len(new_devs)} new developers.")

    if not dry_run:
        backup_path = data_path + ".bak"
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"Backup saved to: {backup_path}")

        data["projects"] = list(existing_projects.values())
        data["developers"] = list(existing_devs.values())
        with open(data_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print("Updated data.json successfully!")

        print("\nRegenerating static HTML pages via generate.py...")
        ret = os.system(f'python "{os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate.py")}"')
        if ret == 0:
            print("Static page generation complete!")
        else:
            print(f"generate.py exited with code: {ret}")
    else:
        print("\nTo apply these changes, run:")
        print("    python sync_notion.py --apply")

if __name__ == "__main__":
    dry_run = "--apply" not in sys.argv
    sync_projects(dry_run=dry_run)
