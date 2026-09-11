# Expert Hospice Audit Assistant (Chrome extension)

Capture tool for the ATTAbot! audit console. Builds the admission/recert
audit prompt, lets you paste back the Claude-for-Chrome result, shows an
editable preview, and submits it to the shared backend for reviewer
confirmation. No data is stored in the extension itself -- everything lives
in the shared Supabase project (`expert-hospice-audit`).

## Load it (unpacked, no build step)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, select this folder
4. Pin the extension, click its icon to open the side panel

## First-time backend setup (one person, once)

Accounts aren't self-serve yet -- an admin creates each staff account:

1. In the Supabase dashboard for the `expert-hospice-audit` project, go to
   **Authentication -> Users -> Add user** and create an account for each
   staff member who will run audits (email + password). A `users_profiles`
   row is created automatically with `role = 'auditor'`.
2. Promote your own account to admin so you can manage checklist rubrics and
   users later (SQL Editor):
   ```sql
   update users_profiles set role = 'admin' where email = 'you@expert-hospice.example';
   ```
3. Promote whoever will confirm/review audits (DON/ADON/QA) to `'reviewer'`.
4. Flag whoever should get the weekly digest email:
   ```sql
   update users_profiles set receives_digest = true where email = '...';
   ```

## Daily use

1. Open the patient's chart in Consolo, open the extension side panel
2. Pick (or add) the patient, pick Admission or Recert
3. **Copy audit prompt** -> paste into Claude for Chrome on the Consolo tab
4. When it finishes, copy the ENTIRE response (including the final ```json
   block at the end) and paste it into the extension
5. **Parse report** -> review/edit every item's status and finding -- this is
   the safeguard step, don't skip it
6. **Submit to audit console** -- it now sits in the dashboard's Pending
   Review queue until a reviewer confirms it

Roles: `auditor` can create and submit audits; `reviewer`/`admin` can confirm
them (only confirmed audits count toward the dashboard/QAPI trends).
