# Chrome Web Store listing -- copy/paste reference

Everything below is ready to paste into the Developer Dashboard. The two
things I can't produce for you (see bottom) need to come from you.

## Visibility
**Unlisted** -- installable only by people with the direct link, not
searchable in the Store. Right choice for an internal staff tool.

## Category
Productivity

## Short description (132 char max)
```
Generates hospice chart-audit prompts, parses Claude for Chrome results, and submits them to the ATTAbot! audit console.
```

## Detailed description
```
Expert Hospice Audit Assistant is the capture tool for ATTAbot!, Expert
Hospice's internal admission/recertification chart-audit system.

It builds the correct audit checklist prompt for a patient (admission or
recertification), you run it through Claude for Chrome against the chart in
Consolo/WellSky, and paste the result back in. The extension parses the
findings, shows them to you for review, and submits them to the shared
ATTAbot! audit console for reviewer confirmation, scoring, and QAPI trending.

Internal tool for Expert Hospice staff only -- requires an ATTAbot! account
created by an Expert Hospice administrator.
```

## Single purpose description (required field)
```
Captures hospice chart-audit findings (generated via a Claude for Chrome
session) and submits them to Expert Hospice's private ATTAbot! audit
backend for review and compliance tracking.
```

## Privacy policy URL
```
https://expert-hospice-audit-dashboard.vercel.app/privacy.html
```

## Permission justifications (Chrome will ask for these per-permission)

**storage** -- keeps you signed in between sessions (stores your login
session token locally) and caches the checklist rubric so it doesn't need
to re-fetch it every time.

**sidePanel** -- the entire UI is a side panel, not a popup, so it can stay
open alongside the Consolo/WellSky tab while you work.

**clipboardWrite** -- used for the "Copy audit prompt to clipboard" button,
so the generated prompt can be pasted directly into Claude for Chrome.

**host_permissions (ywwdgwiqoeqixmbvibeq.supabase.co)** -- the only server
this extension talks to. All audit submission, login, and checklist data
goes through this single Expert Hospice-operated backend.

---

## What I can't produce -- you'll need to supply these

1. **A screenshot** (1280x800 or 640x400 PNG) of the extension's side panel
   actually open, showing real UI (blur out any real patient data first).
   The Store requires this to be a real screenshot, not a mockup.
2. **A Google Developer account** for the Chrome Web Store -- one-time $5
   registration at https://chrome.google.com/webstore/devconsole. This has
   to be under whatever Google account/organization you want to own the
   listing (and be able to push future updates from).
3. **The actual submission** -- zip this extension folder, upload it in the
   Developer Dashboard, paste in the copy above, upload the screenshot and
   icons (already in `icons/`), and submit for review. Google's review for
   an unlisted extension is usually quick (often same-day to a few days).
