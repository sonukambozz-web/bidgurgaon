/* ================================================================
   ADMIN CONSOLE (Bid Gurgaon)

   Auth-gated CRUD over the three Firestore collections that
   js/firebase-data.js reads for the public site: developers,
   channelPartners, projects. Firestore document ID = the "id" slug
   field, so it lines up with the links main.js builds
   (pages/project-<id>.html, pages/developer-<id>.html).

   NOTE ON DETAIL PAGES: public canonical URLs are static pages generated
   from data.json. Firestore is an optional operational data source; use the
   generic detail pages only when a deployment explicitly enables it.
================================================================= */
(function () {
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG || String(window.FIREBASE_CONFIG.apiKey).startsWith('YOUR_')) {
    document.getElementById('login-error').textContent = 'Firebase is not configured yet — check js/firebase-config.js.';
    document.getElementById('login-error').classList.add('show');
    return;
  }

  const auth = firebase.auth();
  const db = firebase.firestore();

  const SCHEMAS = {
    developers: {
      order: 'rank',
      fields: ['id', 'name', 'rank', 'bidAmount', 'bidCycle', 'since', 'rera', 'logo', 'locality', 'tagline', 'projects'],
      arrayFields: ['projects'],
      numberFields: ['rank', 'bidAmount'],
      columns: [
        { label: 'rank', render: d => d.rank ?? '—' },
        { label: 'name', render: d => d.name || '(untitled)', cls: 'name-cell' },
        { label: 'locality', render: d => d.locality || '' },
        { label: 'bid', render: d => d.bidAmount ? '₹' + Number(d.bidAmount).toLocaleString('en-IN') + '/' + (d.bidCycle || 'mo') : '' },
        { label: 'since', render: d => d.since || '' }
      ]
    },
    channelPartners: {
      order: 'rank',
      fields: ['id', 'name', 'rank', 'bidAmount', 'bidCycle', 'since', 'phone', 'whatsapp', 'reraChannel', 'experienceYears', 'photo', 'tagline', 'specialization', 'languages', 'bio', 'activeOn'],
      arrayFields: ['activeOn'],
      numberFields: ['rank', 'bidAmount', 'experienceYears'],
      columns: [
        { label: 'rank', render: d => d.rank ?? '—' },
        { label: 'name', render: d => d.name || '(untitled)', cls: 'name-cell' },
        { label: 'phone', render: d => d.phone || '' },
        { label: 'bid', render: d => d.bidAmount ? '₹' + Number(d.bidAmount).toLocaleString('en-IN') + '/' + (d.bidCycle || 'mo') : '' },
        { label: 'since', render: d => d.since || '' }
      ]
    },
    projects: {
      order: 'name',
      fields: ['id', 'name', 'developerId', 'locality', 'status', 'possession', 'configs', 'sizeRange', 'priceRange', 'rera', 'summary', 'highlights', 'activePartners', 'images'],
      arrayFields: ['highlights', 'activePartners', 'images'],
      numberFields: [],
      columns: [
        { label: 'name', render: d => d.name || '(untitled)', cls: 'name-cell' },
        {
          label: 'developer',
          render: d => {
            const raw = d.developerId || '';
            if (!raw) return '⚠ no developer set';
            const dev = resolveDeveloper(raw);
            return dev ? dev.name : raw + '  ⚠ not linked — no developer matches this ID';
          }
        },
        { label: 'status', render: d => d.status || '' },
        { label: 'locality', render: d => d.locality || '' }
      ]
    }
  };

  const cache = { developers: [], channelPartners: [], projects: [] };
  let editing = { developers: null, channelPartners: null, projects: null };

  /* ---------------- developer linkage check ----------------
     A project only appears on its developer's page if its "Developer ID"
     resolves to a developer record. People type "DLF", "DLF Limited" or
     "dlf-limited" interchangeably, so the public site matches loosely (see
     buildDevIndex in js/main.js) — this mirrors that matching and flags in the
     Projects table anything that still doesn't resolve, so a typo is visible
     here instead of quietly emptying a developer page. */
  const DEV_NOISE = new Set([
    'private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'india', 'group', 'groups',
    'properties', 'property', 'developer', 'developers', 'projects', 'realty',
    'realtors', 'realestate', 'estate', 'estates', 'buildtech', 'infra', 'the', 'and'
  ]);
  function slugKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  function devKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(w => w && !DEV_NOISE.has(w)).join('');
  }
  function resolveDeveloper(raw) {
    const want = String(raw == null ? '' : raw).trim();
    if (!want) return null;
    const devs = cache.developers || [];
    const exact = devs.find(d => d.id === want || d.docId === want);
    if (exact) return exact;
    const keys = [slugKey(want), devKey(want)].filter(Boolean);
    const hits = devs.filter(d => [d.id, d.docId, d.name]
      .some(v => v && (keys.includes(slugKey(v)) || keys.includes(devKey(v)))));
    return hits.length === 1 ? hits[0] : null;   // never guess between two developers
  }

  /* ---------------- utils ---------------- */
  function slugify(s) {
    return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => t.classList.remove('show'), 3200);
  }
  function showFormError(type, msg) {
    const el = document.getElementById(`form-${type}-error`);
    el.textContent = msg;
    el.classList.add('show');
  }
  function clearFormError(type) {
    const el = document.getElementById(`form-${type}-error`);
    el.textContent = '';
    el.classList.remove('show');
  }

  /* ---------------- auth ---------------- */
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.classList.remove('show');
    auth.signInWithEmailAndPassword(email, password).catch(err => {
      errEl.textContent = err.message || 'Sign in failed.';
      errEl.classList.add('show');
    });
  });

  document.getElementById('signout-btn').addEventListener('click', () => auth.signOut());

  /* ---------------- export data.json (READ ONLY) ----------------
     generate.py pre-renders one HTML page per developer and per project from
     data.json, and lists them in sitemap.xml — that is what makes them
     indexable at a clean /pages/developer-<slug> URL. Records added here live
     only in Firestore, so data.json goes stale and those developers have no
     page of their own to index. This button reads the three collections plus
     meta/site and downloads them in exactly data.json's shape; drop the file
     into the site folder, re-run generate.py and redeploy.

     It only ever READS from Firestore — no document is created, changed or
     deleted, and nothing about authentication is touched. The site's own
     settings that this console doesn't manage (minimum outbid steps, UPI
     details) are carried over from the current data.json so they survive. */
  document.getElementById('export-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    try {
      const [devSnap, cpSnap, projSnap, siteSnap] = await Promise.all([
        db.collection('developers').get(),
        db.collection('channelPartners').get(),
        db.collection('projects').get(),
        db.collection('meta').doc('site').get().catch(() => null)
      ]);

      // Firestore doc id is the slug, so fall back to it when a record's own
      // "id" field was never filled in — otherwise generate.py would skip it.
      const rows = snap => snap.docs.map(doc => {
        const { docId, ...rest } = doc.data();
        return { ...rest, id: String(rest.id || doc.id) };
      });

      let baseSite = {};
      try {
        baseSite = (await (await fetch('../data.json', { cache: 'no-store' })).json()).site || {};
      } catch (err) { /* first export, or data.json unreadable — carry on */ }

      const byRank = (a, b) => (Number(a.rank) || 9999) - (Number(b.rank) || 9999);
      const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
      const out = {
        site: { ...baseSite, ...(siteSnap && siteSnap.exists ? siteSnap.data() : {}) },
        developers: rows(devSnap).sort(byRank),
        channelPartners: rows(cpSnap).sort(byRank),
        projects: rows(projSnap).sort(byName)
      };

      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Exported ${out.developers.length} developers, ${out.projects.length} projects, ${out.channelPartners.length} partners.`);
    } catch (err) {
      toast(err.message || 'Export failed — check your connection and try again.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  auth.onAuthStateChanged((user) => {
    const loginView = document.getElementById('login-view');
    const dashView = document.getElementById('dashboard-view');
    if (user) {
      loginView.style.display = 'none';
      dashView.style.display = 'block';
      document.getElementById('who-email').textContent = user.email;
      loadAll();
    } else {
      loginView.style.display = 'block';
      dashView.style.display = 'none';
    }
  });

  /* ---------------- tabs ---------------- */
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  /* ---------------- load + render ---------------- */
  async function loadAll() {
    await Promise.all([...Object.keys(SCHEMAS).map(loadCollection), loadSiteContent()]);
    // The collections load in parallel, so the projects table may have rendered
    // before cache.developers arrived — re-render it now that linkage can be
    // resolved, otherwise every row would read "not linked".
    renderTable('projects');
    // populate developer-id datalist for the project form
    const dl = document.getElementById('developer-ids');
    dl.innerHTML = cache.developers.map(d => `<option value="${escapeHtml(String(d.id || ''))}"></option>`).join('');
  }

  /* ---------------- site content (single doc: meta/site) ---------------- */
  const SITE_CONTENT_FIELDS = [
    'name', 'fullName', 'tagline', 'domain', 'supportPhone', 'whatsappNumber',
    'heroEyebrow', 'heroLede', 'heroCtaPrimary', 'heroCtaSecondary',
    'hiw1Title', 'hiw1Desc', 'hiw2Title', 'hiw2Desc', 'hiw3Title', 'hiw3Desc',
    'footerNote',
    'devEyebrow', 'devH1', 'devDesc',
    'devStep1Title', 'devStep1Desc', 'devStep2Title', 'devStep2Desc', 'devStep3Title', 'devStep3Desc',
    'devCtaHeading', 'devCtaDesc',
    'partnerEyebrow', 'partnerH1', 'partnerDesc',
    'partnerStep1Title', 'partnerStep1Desc', 'partnerStep2Title', 'partnerStep2Desc', 'partnerStep3Title', 'partnerStep3Desc',
    'partnerCtaHeading', 'partnerCtaDesc'
  ];

  async function loadSiteContent() {
    try {
      const snap = await db.collection('meta').doc('site').get();
      const data = snap.exists ? snap.data() : {};
      SITE_CONTENT_FIELDS.forEach(f => {
        const input = document.querySelector(`#form-siteContent [data-sc="${f}"]`);
        if (input) input.value = data[f] ?? '';
      });
    } catch (e) {
      showFormError('siteContent', 'Could not load site content: ' + (e.message || e));
    }
  }

  document.getElementById('save-siteContent').addEventListener('click', async () => {
    clearFormError('siteContent');
    const data = {};
    SITE_CONTENT_FIELDS.forEach(f => {
      const input = document.querySelector(`#form-siteContent [data-sc="${f}"]`);
      if (input) data[f] = input.value;
    });
    try {
      await db.collection('meta').doc('site').set(data, { merge: true });
      toast('Site content saved — live on the site now.');
    } catch (e) {
      showFormError('siteContent', e.message || 'Save failed — check Firestore security rules allow writes for your signed-in account.');
    }
  });

  async function loadCollection(type) {
    const schema = SCHEMAS[type];
    try {
      const snap = await db.collection(type).orderBy(schema.order).get();
      cache[type] = snap.docs.map(doc => ({ docId: doc.id, ...doc.data() }));
    } catch (e) {
      // orderBy field may not exist on every doc yet — fall back to unordered
      const snap = await db.collection(type).get();
      cache[type] = snap.docs.map(doc => ({ docId: doc.id, ...doc.data() }));
    }
    renderTable(type);
  }

  function renderTable(type) {
    const schema = SCHEMAS[type];
    const tbody = document.getElementById('table-' + type);
    document.getElementById('count-' + type).textContent = `(${cache[type].length})`;
    if (cache[type].length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="${schema.columns.length + 1}">No entries yet — add the first one above.</td></tr>`;
      return;
    }
    tbody.innerHTML = cache[type].map(d => `
      <tr>
        ${schema.columns.map(c => `<td class="${c.cls || ''}">${escapeHtml(String(c.render(d)))}</td>`).join('')}
        <td class="row-actions">
          <button class="btn btn-outline btn-sm" data-edit="${type}" data-id="${d.docId}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete="${type}" data-id="${d.docId}">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- form open/close/populate ---------------- */
  document.querySelectorAll('[data-open-form]').forEach(btn => {
    btn.addEventListener('click', () => openForm(btn.dataset.openForm, null));
  });
  document.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => closeForm(btn.dataset.cancel));
  });

  function formEl(type) { return document.getElementById('form-' + type); }

  function openForm(type, docId) {
    const card = formEl(type);
    const schema = SCHEMAS[type];
    editing[type] = docId;
    clearFormError(type);
    document.getElementById(`form-${type}-title`).textContent = docId ? 'Edit entry' : 'Add ' + (type === 'channelPartners' ? 'channel partner' : type.slice(0, -1));

    const record = docId ? cache[type].find(d => d.docId === docId) : null;
    schema.fields.forEach(f => {
      const input = card.querySelector(`[data-f="${f}"]`);
      if (!input) return;
      let val = record ? record[f] : '';
      if (schema.arrayFields.includes(f)) val = Array.isArray(val) ? val.join('\n') : '';
      input.value = val ?? '';
    });
    // slug locks once a doc exists (changing it would create a duplicate doc, not rename)
    const idInput = card.querySelector('[data-f="id"]');
    if (idInput) idInput.disabled = !!docId;

    card.classList.add('open');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeForm(type) {
    formEl(type).classList.remove('open');
    editing[type] = null;
  }

  /* ---------------- save ---------------- */
  document.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', () => saveForm(btn.dataset.save));
  });

  async function saveForm(type) {
    const schema = SCHEMAS[type];
    const card = formEl(type);
    clearFormError(type);

    const nameInput = card.querySelector('[data-f="name"]');
    const idInput = card.querySelector('[data-f="id"]');
    const name = (nameInput.value || '').trim();
    if (!name) { showFormError(type, 'Name is required.'); return; }

    let id = editing[type] || slugify(idInput.value) || slugify(name);
    if (!id) { showFormError(type, 'Could not derive a slug/ID — enter one manually.'); return; }
    if (!editing[type] && cache[type].some(d => d.docId === id)) {
      showFormError(type, `"${id}" already exists — pick a different Slug / ID.`);
      return;
    }

    const data = {};
    schema.fields.forEach(f => {
      const input = card.querySelector(`[data-f="${f}"]`);
      if (!input) return;
      let val = input.value;
      if (schema.arrayFields.includes(f)) {
        val = val.split('\n').map(s => s.trim()).filter(Boolean);
      } else if (schema.numberFields.includes(f)) {
        val = val === '' ? 0 : Number(val);
      }
      data[f] = val;
    });
    data.id = id;

    try {
      await db.collection(type).doc(id).set(data);
      toast('Saved.');
      closeForm(type);
      await loadCollection(type);
      if (type === 'developers') {
        document.getElementById('developer-ids').innerHTML = cache.developers.map(d => `<option value="${escapeHtml(String(d.id || ''))}"></option>`).join('');
      }
    } catch (e) {
      showFormError(type, e.message || 'Save failed — check Firestore security rules allow writes for your signed-in account.');
    }
  }

  /* ---------------- edit / delete (event delegation) ---------------- */
  document.getElementById('dashboard-view').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openForm(editBtn.dataset.edit, editBtn.dataset.id); return; }

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      const type = delBtn.dataset.delete;
      const id = delBtn.dataset.id;
      const record = cache[type].find(d => d.docId === id);
      if (!confirm(`Delete "${record ? record.name : id}"? This can't be undone.`)) return;
      db.collection(type).doc(id).delete()
        .then(() => { toast('Deleted.'); loadCollection(type); })
        .catch(err => toast(err.message || 'Delete failed.', true));
    }
  });
})();
