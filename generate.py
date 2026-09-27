#!/usr/bin/env python3
"""
Bid Gurgaon — static page generator.

Reads data.json (the single source of truth also used by js/main.js)
and writes one static HTML file per project and per developer into
/pages, plus a sitemap.xml. Re-run this any time data.json changes.

Usage:  python3 generate.py
"""
import json
import os
import glob
import re
from html import escape, unescape
from urllib.parse import quote
from datetime import date

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.join(ROOT, "pages")
DOMAIN = "https://bidgurgaon.in"

with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as f:
    RAW_DATA = json.load(f)


def escape_html_values(value):
    if isinstance(value, dict):
        return {key: escape_html_values(child) for key, child in value.items()}
    if isinstance(value, list):
        return [escape_html_values(child) for child in value]
    if isinstance(value, str):
        return escape(value, quote=True)
    return value


DATA = escape_html_values(RAW_DATA)

DEVELOPERS = {d["id"]: d for d in DATA["developers"]}
PARTNERS = {p["id"]: p for p in DATA["channelPartners"]}
PROJECTS = DATA["projects"]

# ---- developer ↔ project linkage -------------------------------------------
# A project's developer is stored as free text in the admin panel, so the same
# company arrives as "dlf-limited", "dlf", "DLF Limited" or "DLF Ltd."
# depending on who typed it. Matching on strict equality left most projects
# orphaned — the DLF page listed 6 of its projects and project cards showed a
# blank developer name — so every lookup goes through this index instead.
# Mirrors buildDevIndex() in js/main.js; keep the two in step.
_DEV_NOISE = {
    "private", "pvt", "limited", "ltd", "llp", "inc", "india", "group", "groups",
    "properties", "property", "developer", "developers", "projects", "realty",
    "realtors", "realestate", "estate", "estates", "buildtech", "infra", "the", "and",
}


def slug_key(s):
    return re.sub(r"[^a-z0-9]+", "-", unescape(str(s or "")).lower()).strip("-")


def dev_key(s):
    """Aggressive key: drops corporate-suffix noise so "DLF Ltd." == "dlf-limited"."""
    words = re.sub(r"[^a-z0-9]+", " ", unescape(str(s or "")).lower()).split()
    return "".join(w for w in words if w not in _DEV_NOISE)


def _build_dev_index():
    fuzzy, ambiguous = {}, set()
    for dev in DATA["developers"]:
        for raw in (dev.get("id"), dev.get("docId"), dev.get("name")):
            for key in (slug_key(raw), dev_key(raw)):
                if not key:
                    continue
                if key in fuzzy and fuzzy[key]["id"] != dev["id"]:
                    ambiguous.add(key)   # never guess between two developers
                else:
                    fuzzy[key] = dev
    for key in ambiguous:
        fuzzy.pop(key, None)
    return fuzzy


DEV_FUZZY = _build_dev_index()


def dev_for(project):
    raw = project.get("developerId") or project.get("developer") or project.get("developerName") or ""
    return DEVELOPERS.get(raw) or DEV_FUZZY.get(slug_key(raw)) or DEV_FUZZY.get(dev_key(raw))


def projects_for(dev):
    """Every project that resolves to this developer, plus any id listed on the
    developer's own projects[] array — union, de-duped, in data.json order."""
    listed = set(dev.get("projects") or [])
    out = []
    for project in PROJECTS:
        owner = dev_for(project)
        if (owner and owner["id"] == dev["id"]) or project["id"] in listed:
            out.append(project)
    return out


def project_partners(project):
    partner_ids = set(project.get("activePartners", []))
    partner_ids.update(partner["id"] for partner in PARTNERS.values() if project["id"] in partner.get("activeOn", []))
    return sorted(
        (PARTNERS[partner_id] for partner_id in partner_ids if partner_id in PARTNERS),
        key=lambda partner: partner.get("bidAmount", 0),
        reverse=True,
    )


def project_card(project, developer):
    partners = project_partners(project)
    status = normalize_status(project.get("status"))
    status_badge = f'<span class="pcard-status">{status}</span>' if status else ''
    if partners:
        partner_names = "".join(f'<span class="pcard-partner-name">{partner["name"]}</span>' for partner in partners[:3])
        more_count = len(partners) - 3
        if more_count > 0:
            partner_names += f'<span class="pcard-partner-more">+{more_count} more</span>'
        partner_html = f'''<div class="pcard-partners">
              <span class="pcard-partners-label">Active channel partners</span>
              <span class="pcard-partner-list">{partner_names}</span>
            </div>'''
    else:
        partner_html = '''<div class="pcard-partners">
              <span class="pcard-partners-label">Active channel partners</span>
              <span class="pcard-partners-empty">None listed yet</span>
            </div>'''

    return f'''
        <a class="pcard" href="project-{project['id']}">
          <div class="pcard-media pcard-gallery">{project_media_inner(project, status_badge)}</div>
          <div class="pcard-body">
            <div class="dev">{developer['name']}</div>
            <h3>{project['name']}</h3>
            <div class="loc">{project['locality']}</div>
            <div class="pcard-specs"><span><b>{project['configs']}</b></span><span><b>{project['sizeRange']}</b></span></div>
            {partner_html}
            <div class="pcard-foot"><span class="price">{project['priceRange']}</span><span class="btn btn-outline btn-sm">Read more</span></div>
          </div>
        </a>'''


def fmt_inr(amount):
    s = str(int(round(amount)))
    if len(s) <= 3:
        return "₹" + s
    last3 = s[-3:]
    other = s[:-3]
    groups = []
    while len(other) > 2:
        groups.insert(0, other[-2:])
        other = other[:-2]
    if other:
        groups.insert(0, other)
    return "₹" + ",".join(groups) + "," + last3


def rera_phrase(raw):
    """Reads sensibly whether the record carries a real RERA number or not.
    Developers register per project, so a blank/'N/A' value is normal — it must
    not surface as the literal string "RERA N/A — registered per-project"."""
    v = (raw or "").strip()
    if not v or v.lower().startswith("n/a") or v in ("-", "—", "None"):
        return "RERA-registered per project"
    return "RERA " + v


def live_rank_hook(dev, fmt, fallback=""):
    """Rank and bid amount are Firestore-owned and change every time someone
    outbids someone else, so they must never be baked into static HTML (that is
    what produced "Rank #0 on the board · ₹0/mo"). Emit a hook that
    fillLiveDevStats() in js/main.js fills from live data instead; with no
    fallback the span stays hidden, so the page degrades cleanly."""
    hidden = "" if fallback else " hidden"
    return (
        f'<span class="live-dev-stat" data-live-rank="{dev["id"]}"'
        f' data-live-format="{fmt}"{hidden}>{fallback}</span>'
    )


def fmt_date(iso):
    if not iso:
        return "—"
    y, m, d = iso.split("-")
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    return f"{int(d)} {months[int(m)-1]} {y}"


# ---- SEO helpers -----------------------------------------------------------
# Canonical 5-stage taxonomy. Mirrors normalizeStatus() in js/main.js so the
# static pages and the live client-rendered views always show the same tags.
STATUS_ORDER = ["Pre-Launch", "New Launch", "Under Construction", "Near Possession", "Ready to Move"]


def normalize_status(raw):
    s = (raw or "").lower().strip()
    if not s:
        return ""
    if any(k in s for k in ("pre-launch", "pre launch", "prelaunch", "upcoming", "coming soon")):
        return "Pre-Launch"
    if any(k in s for k in ("new launch", "newly launched", "just launched")):
        return "New Launch"
    if any(k in s for k in ("ready to move", "ready-to-move", "rtm", "delivered", "operational", "completed", "handed over")):
        return "Ready to Move"
    if any(k in s for k in ("near possession", "nearing possession", "near-possession", "possession soon", "possession commenced", "possession recently")) or ("possession" in s and "await" not in s):
        return "Near Possession"
    if any(k in s for k in ("under construction", "under-construction", "construction", "ongoing")):
        return "Under Construction"
    return ""


def locality_full(project):
    """Return the locality without duplicating 'Gurugram'."""
    loc = (project.get("locality") or "").strip()
    if not loc:
        return "Gurugram, Haryana"
    if "gurugram" in loc.lower() or "gurgaon" in loc.lower():
        return loc
    return f"{loc}, Gurugram"


def clip(text, limit):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit - 1].rsplit(" ", 1)[0].rstrip(",;. ") + "…"


def build_descriptions(project, dev, status):
    """Build a clean meta description that skips empty fields — no orphan
    punctuation like '. , . RERA .' from unfilled template slots."""
    loc = locality_full(project)
    summary = (project.get("summary") or "").strip()

    if summary:
        base = summary
    else:
        stage = f"{status.lower()} " if status else ""
        base = f"{project['name']} is a {stage}residential project by {dev['name']} in {loc}."

    facts = []
    if project.get("configs"):
        facts.append(project["configs"])
    if project.get("sizeRange"):
        facts.append(project["sizeRange"])
    if project.get("priceRange"):
        facts.append(project["priceRange"])
    poss = (project.get("possession") or "").strip()
    if poss and status != "Ready to Move":
        facts.append(f"possession {poss}")
    if project.get("rera"):
        facts.append(f"RERA {project['rera']}")

    detail = f" {'; '.join(facts)}." if facts else ""
    meta = clip(base + detail, 158)
    social = clip(base, 150)
    return meta, social


def spec_cell(value):
    v = (value or "").strip() if isinstance(value, str) else value
    return v if v else "—"


PH_ICON = ('<svg class="ph-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
           'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
           '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/>'
           '<path d="M21 16l-5-5L5 20"/></svg>')


def _shot(url, cls, alt, label=""):
    if url:
        return f'<img class="pcard-shot {cls}" src="{url}" alt="{alt}" loading="lazy">'
    label_html = f'<span class="ph-label">{label}</span>' if label else ""
    return f'<span class="pcard-shot pcard-shot--ph {cls}" aria-hidden="true">{PH_ICON}{label_html}</span>'


def project_media_inner(project, status_badge):
    imgs = [u for u in (project.get("images") or []) if u]
    alt = project.get("name", "Project")
    return (
        f'{status_badge}'
        f'<span class="pcard-rera-tag">RERA ✓</span>'
        f'{_shot(imgs[0] if len(imgs) > 0 else "", "pcard-shot--main", alt, project.get("name", ""))}'
        f'<div class="pcard-thumbs">'
        f'{_shot(imgs[1] if len(imgs) > 1 else "", "pcard-shot--thumb", alt)}'
        f'{_shot(imgs[2] if len(imgs) > 2 else "", "pcard-shot--thumb", alt)}'
        f'{_shot(imgs[3] if len(imgs) > 3 else "", "pcard-shot--thumb", alt)}'
        f'</div>'
    )


def detail_media_inner(project):
    """Large hero gallery for the project detail page: 1 main + 3 thumbs.
    Uses real photos from project['images'] when present, else placeholders."""
    imgs = [u for u in (project.get("images") or []) if u]
    alt = project.get("name", "Project")
    return (
        f'<div class="dg-main">'
        f'{_shot(imgs[0] if len(imgs) > 0 else "", "dg-shot dg-shot--main", alt, project.get("name", ""))}'
        f'</div>'
        f'<div class="dg-thumbs">'
        f'{_shot(imgs[1] if len(imgs) > 1 else "", "dg-shot dg-shot--thumb", alt)}'
        f'{_shot(imgs[2] if len(imgs) > 2 else "", "dg-shot dg-shot--thumb", alt)}'
        f'{_shot(imgs[3] if len(imgs) > 3 else "", "dg-shot dg-shot--thumb", alt)}'
        f'</div>'
    )




NAV = """
<nav class="site-nav">
  <div class="wrap">
    <a href="../index.html" class="brand"><img src="../img/logo-full.png" alt="Bid Gurgaon — Rank, Outbid, Be Noticed" class="brand-logo"></a>
    <ul class="nav-links">
      <li><a href="../index.html">Home</a></li>
      <li><a href="developers.html">Developer Leaderboard</a></li>
      <li><a href="channel-partners.html">Channel Partners</a></li>
      <li><a href="projects.html" class="active">Projects</a></li>
      <li><a href="how-it-works.html">How It Works</a></li>
      <li><a href="for-developers.html">List Your Project</a></li>
    </ul>
    <div class="nav-cta">
      <a href="for-developers.html" class="btn btn-outline btn-sm">Get on the board</a>
      <button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false">
        <span class="nav-toggle-bar"></span>
        <span class="nav-toggle-bar"></span>
        <span class="nav-toggle-bar"></span>
      </button>
    </div>
  </div>
</nav>
"""

FOOTER = """
<footer>
  <div class="wrap">
    <div class="foot-bottom">
      <span>© 2026 Bid Gurgaon. Bid amounts shown represent paid visibility positions on the Bid Gurgaon board — position is determined by visibility bid, not by a rating of developer quality. Project details are not independently verified; confirm them with the developer before you transact.</span>
      <span>Gurugram, Haryana</span>
    </div>
  </div>
</footer>
"""


def project_page(project):
    dev = dev_for(project) or {
        "id": "", "name": "", "logo": "—", "rera": "", "rank": 0,
        "bidAmount": 0, "bidCycle": "month", "tagline": "", "since": "", "locality": "",
    }
    partners = project_partners(project)
    status = normalize_status(project.get("status"))
    loc = locality_full(project)
    meta_desc, social_desc = build_descriptions(project, dev, status)

    highlights_html = "\n".join(f"<li>{h}</li>" for h in project["highlights"])

    # A project whose developerId doesn't resolve must not emit "by " with an
    # empty name or a link to developer-.html.
    if dev["id"]:
        dev_byline = (
            f'by <a href="developer-{dev["id"]}" style="color:var(--brass-bright)">{dev["name"]}</a>'
        )
        dev_all_link = (
            f'<a href="developer-{dev["id"]}" class="btn btn-outline btn-block btn-sm"'
            f' style="margin-top:16px;">See all {dev["name"].split()[0]} projects</a>'
        )
    else:
        dev_byline = ""
        dev_all_link = (
            '<a href="developers.html" class="btn btn-outline btn-block btn-sm"'
            ' style="margin-top:16px;">Browse all developers</a>'
        )

    partner_rows = ""
    for position, p in enumerate(partners, start=1):
        partner_rows += f"""
        <div class="partner-row">
          <div class="logo">{''.join(w[0] for w in p['name'].split()[:2])}</div>
          <div class="info">
            <div class="n">#{position} {p['name']} <span class="badge-rera" style="margin-left:4px;">RERA ✓</span></div>
            <div class="b">{fmt_inr(p['bidAmount'])}/{p['bidCycle']} · on this project since {fmt_date(p['since'])}</div>
          </div>
        </div>
        <div class="call-strip">
          <a class="btn btn-call btn-sm btn-block" href="tel:{p['phone'].replace(' ', '')}">Call {p['name'].split()[0]}</a>
        </div>
        """

    if partners:
        top_partner = partners[0]
        mobile_bar = f"""
<div class="mobile-call-bar">
  <a class="btn btn-outline btn-sm" style="flex:1;justify-content:center" href="https://wa.me/{top_partner['whatsapp'].replace(' ','').replace('+','')}">WhatsApp</a>
  <a class="btn btn-call btn-sm" style="flex:2;justify-content:center" href="tel:{top_partner['phone'].replace(' ','')}">Call {top_partner['name'].split()[0]} now</a>
</div>"""
    else:
        mobile_bar = ""

    schema = {
        "@context": "https://schema.org",
        "@type": "Residence",
        "name": project["name"],
        "description": social_desc,
        "url": f"{DOMAIN}/pages/project-{project['id']}",
        "address": {
            "@type": "PostalAddress",
            "addressLocality": loc,
            "addressRegion": "Haryana",
            "addressCountry": "IN"
        },
        "brand": {"@type": "Organization", "name": dev["name"]}
    }

    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{DOMAIN}/"},
            {"@type": "ListItem", "position": 2, "name": "Projects", "item": f"{DOMAIN}/pages/projects"},
            {"@type": "ListItem", "position": 3, "name": project["name"], "item": f"{DOMAIN}/pages/project-{project['id']}"}
        ]
    }

    partner_cta = f"""
        <div class="sidebar-card" style="text-align:center;">
          <h4>Are you a channel partner on {project['name']}?</h4>
          <p class="small-print" style="margin:8px 0 16px;">Get featured here in front of every buyer viewing this project. Register and place a position bid — pay more than the partner above you to move up.</p>
          <a href="for-partners.html?project={project['id']}" class="btn btn-bid btn-block btn-sm">Bid to be featured on this project</a>
          {f'<a href="bid-now.html?type=partner&rank=1&entity={quote(partners[0]["name"])}&current={partners[0].get("bidAmount", 0)}" class="btn btn-outline btn-block btn-sm" style="margin-top:10px;">Outbid the top partner ({fmt_inr(partners[0].get("bidAmount", 0))}/mo)</a>' if partners else ''}
        </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en-IN">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Y9Y2WHJBKD"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', 'G-Y9Y2WHJBKD');
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" sizes="32x32" href="../img/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../img/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../img/favicon-180.png">
<title>{project['name']} — {loc} | {dev['name']}</title>
<meta name="description" content="{meta_desc}">
<link rel="canonical" href="{DOMAIN}/pages/project-{project['id']}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bid Gurgaon">
<meta property="og:locale" content="en_IN">
<meta property="og:title" content="{project['name']} — {dev['name']}, Gurugram">
<meta property="og:description" content="{social_desc}">
<meta property="og:url" content="{DOMAIN}/pages/project-{project['id']}">
<meta property="og:image" content="{DOMAIN}/img/favicon-512.png">
<meta property="og:image:secure_url" content="{DOMAIN}/img/favicon-512.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:image:alt" content="Bid Gurgaon">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{project['name']} — {dev['name']}, Gurugram">
<meta name="twitter:description" content="{social_desc}">
<meta name="twitter:image" content="{DOMAIN}/img/favicon-512.png">
<link rel="stylesheet" href="../css/style.css">
<script type="application/ld+json">{json.dumps(schema)}</script>
<script type="application/ld+json">{json.dumps(breadcrumb)}</script>
</head>
<body>
{NAV}

<header class="page-head">
  <div class="wrap">
    <div class="breadcrumb"><a href="../index.html">Home</a> / <a href="projects.html">Projects</a> / {project['name']}</div>
    <span class="eyebrow">{(status + ' · ') if status else ''}{loc}</span>
    <h1>{project['name']}</h1>
    <p class="desc">{dev_byline}{f' · RERA {project["rera"]}' if project.get('rera') else ''}</p>
  </div>
</header>

<section class="section">
  <div class="wrap">
    <div class="detail-grid">
      <div>
        <div class="detail-hero-media detail-gallery">{detail_media_inner(project)}</div>

        <span class="eyebrow">About this project</span>
        <p style="margin-top:14px; color:var(--paper-dim); font-size:16px; line-height:1.85; max-width:65ch;">{project['summary'] if project.get('summary') else social_desc}</p>

        <table class="spec-table">
          <tr><td>Status</td><td>{spec_cell(status)}</td></tr>
          <tr><td>Possession</td><td>{spec_cell(project['possession'])}</td></tr>
          <tr><td>Configurations</td><td>{spec_cell(project['configs'])}</td></tr>
          <tr><td>Size range</td><td>{spec_cell(project['sizeRange'])}</td></tr>
          <tr><td>Price range</td><td>{spec_cell(project['priceRange'])}</td></tr>
          <tr><td>Locality</td><td>{loc}</td></tr>
          <tr><td>RERA registration</td><td>{spec_cell(project['rera'])}</td></tr>
        </table>

        <span class="eyebrow">Highlights</span>
        <ul class="highlight-list" style="margin-top:16px;">
          {highlights_html}
        </ul>
      </div>

      <div>
        <div class="sidebar-card">
          <h4>Developer</h4>
          <div class="dev-card-mini">
            <div class="logo">{dev['logo']}</div>
            <div>
              <div style="font-weight:600;">{dev['name'] or 'Developer not linked yet'} <span class="badge-rera">RERA ✓</span></div>
              <div class="small-print" style="margin-top:4px;">{live_rank_hook(dev, 'rank-bid', rera_phrase(dev['rera'])) if dev['id'] else 'RERA-registered per project'}</div>
            </div>
          </div>
          {dev_all_link}
        </div>

        <div class="sidebar-card">
          <h4>Active Channel Partners on this project</h4>
          {partner_rows if partners else '<p class="small-print">No channel partner has taken this project yet.</p>'}
        </div>
{partner_cta}
        <p class="small-print">Ranked by position bid for this specific project — highest bid appears first. Any registered partner may outbid another to move up.</p>
      </div>
    </div>
  </div>
</section>
{mobile_bar}
{FOOTER}
<script src="https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-compat.js"></script>
<script src="../js/firebase-config.js"></script>
<script src="../js/firebase-data.js"></script>
<script src="../js/market.js"></script>
<script src="../js/main.js"></script>
</body>
</html>
"""
    return html


def developer_page(dev):
    dev_projects = projects_for(dev)
    cards = ""
    for p in dev_projects:
        cards += project_card(p, dev)

    # "On the board since …" only reads well when we actually have the date, and
    # the bid clause only when a real bid exists (data.json seeds it at 0).
    since_clause = ""
    if dev.get("since"):
        since_clause = f" On the board since {fmt_date(dev['since'])}."
    if dev.get("bidAmount"):
        cycle = dev.get("bidCycle") or "month"
        bid = fmt_inr(dev["bidAmount"])
        since_clause = (
            f" On the board since {fmt_date(dev['since'])}, currently bidding {bid}/{cycle} to hold position."
            if dev.get("since")
            else f" Currently bidding {bid}/{cycle} to hold position."
        )

    schema = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": dev["name"],
        "url": f"{DOMAIN}/pages/developer-{dev['id']}",
        "areaServed": "Gurugram, Haryana",
        "description": dev.get("tagline", "")
    }

    dev_breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{DOMAIN}/"},
            {"@type": "ListItem", "position": 2, "name": "Developer Leaderboard", "item": f"{DOMAIN}/pages/developers"},
            {"@type": "ListItem", "position": 3, "name": dev["name"], "item": f"{DOMAIN}/pages/developer-{dev['id']}"}
        ]
    }

    html = f"""<!DOCTYPE html>
<html lang="en-IN">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-Y9Y2WHJBKD"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', 'G-Y9Y2WHJBKD');
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" sizes="32x32" href="../img/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../img/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../img/favicon-180.png">
<title>{dev['name']} — Projects in Gurugram | Bid Gurgaon</title>
<meta name="description" content="{dev['name']} on the Bid Gurgaon Gurugram developer leaderboard — {rera_phrase(dev['rera'])}. {dev['tagline']}">
<link rel="canonical" href="{DOMAIN}/pages/developer-{dev['id']}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bid Gurgaon">
<meta property="og:locale" content="en_IN">
<meta property="og:title" content="{dev['name']} — Projects in Gurugram | Bid Gurgaon">
<meta property="og:description" content="{dev['name']} — projects, localities and live board position on Bid Gurgaon, Gurugram's open real-estate leaderboard.">
<meta property="og:url" content="{DOMAIN}/pages/developer-{dev['id']}">
<meta property="og:image" content="{DOMAIN}/img/favicon-512.png">
<meta property="og:image:secure_url" content="{DOMAIN}/img/favicon-512.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:image:alt" content="Bid Gurgaon">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{dev['name']} — Projects in Gurugram | Bid Gurgaon">
<meta name="twitter:description" content="{dev['name']} — projects, localities and live board position on Bid Gurgaon, Gurugram's open real-estate leaderboard.">
<meta name="twitter:image" content="{DOMAIN}/img/favicon-512.png">
<link rel="stylesheet" href="../css/style.css">
<script type="application/ld+json">{json.dumps(schema)}</script>
<script type="application/ld+json">{json.dumps(dev_breadcrumb)}</script>
</head>
<body>
{NAV}

<header class="page-head">
  <div class="wrap">
    <div class="breadcrumb"><a href="../index.html">Home</a> / <a href="developers.html">Developers</a> / {dev['name']}</div>
    <span class="eyebrow">{live_rank_hook(dev, 'rank-sep')}{rera_phrase(dev['rera'])}</span>
    <h1>{dev['name']}</h1>
    <p class="desc">{dev['tagline']}{since_clause}</p>
  </div>
</header>

<section class="section">
  <div class="wrap">
    <span class="eyebrow">Showcased projects · <span data-live-project-count="{dev['id']}">{len(dev_projects)}</span> listed</span>
    <div class="project-grid" style="margin-top:20px;" data-live-projects="{dev['id']}">
      {cards if dev_projects else '<p class="small-print">Loading this developer&#39;s projects…</p>'}
    </div>
  </div>
</section>
{FOOTER}
<script src="https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore-compat.js"></script>
<script src="../js/firebase-config.js"></script>
<script src="../js/firebase-data.js"></script>
<script src="../js/market.js"></script>
<script src="../js/main.js"></script>
</body>
</html>
"""
    return html


def build():
    os.makedirs(PAGES, exist_ok=True)
    # Extensionless URLs throughout: firebase.json sets cleanUrls, so
    # /pages/x.html 301-redirects to /pages/x. Listing the clean form keeps the
    # sitemap, the canonical tag and the address Google indexes identical, with
    # no redirect hop in between.
    urls = [f"{DOMAIN}/", f"{DOMAIN}/pages/developers",
            f"{DOMAIN}/pages/channel-partners", f"{DOMAIN}/pages/projects",
            f"{DOMAIN}/pages/how-it-works", f"{DOMAIN}/pages/for-developers",
            f"{DOMAIN}/pages/for-partners"]

    expected_pages = {
        *(f"project-{project['id']}.html" for project in PROJECTS),
        *(f"developer-{developer['id']}.html" for developer in DEVELOPERS.values()),
    }

    # Detail pages are build artefacts, never hand-maintained sources. Remove
    # stale artefacts so deleted records cannot remain public or in the sitemap.
    for pattern in ("project-*.html", "developer-*.html"):
        for path in glob.glob(os.path.join(PAGES, pattern)):
            if os.path.basename(path) not in expected_pages:
                os.remove(path)
                print("removed stale", path)

    for project in PROJECTS:
        path = os.path.join(PAGES, f"project-{project['id']}.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(project_page(project))
        urls.append(f"{DOMAIN}/pages/project-{project['id']}")
        print("wrote", path)

    for dev in DEVELOPERS.values():
        path = os.path.join(PAGES, f"developer-{dev['id']}.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(developer_page(dev))
        urls.append(f"{DOMAIN}/pages/developer-{dev['id']}")
        print("wrote", path)

    today = date.today().isoformat()
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        sitemap.append(f"  <url><loc>{u}</loc><lastmod>{today}</lastmod></url>")
    sitemap.append("</urlset>")
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write("\n".join(sitemap))
    print("wrote sitemap.xml with", len(urls), "urls")


if __name__ == "__main__":
    build()
