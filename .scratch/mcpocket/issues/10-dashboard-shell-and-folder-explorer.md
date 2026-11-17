# 10: Dashboard shell + folder explorer

**What to build:** An admin opens the MCPocket dashboard, logs in, and manages the hierarchy from a collapsible folder tree on the left: create folders and subfolders, rename, move folders, create tubes inside folders, move tubes between folders, expand/collapse.

Branding per plan §0: product name, tagline and capabilities on the login/landing page, header and page metadata.

**Blocked by:** 03 — Tubes via REST

**Status:** done

- [x] Admin login (credentials from env / initial admin setup); dashboard routes protected; session cookie, not an API key in the browser
- [x] Dashboard reads/writes through the same application services (server components / server actions), not by touching storage
- [x] Tree shows folders and tubes, collapsible, with expand state preserved while navigating
- [x] Create / rename / move folder and create / move tube via dialogs, with server-side validation errors (cycle, non-empty delete) shown to the user
- [x] Built with existing shadcn/Tailwind components; responsive; light/dark via the existing theme provider
- [x] Selecting a tube navigates to a tube route (placeholder content until 11)
