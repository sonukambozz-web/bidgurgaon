/* ================================================================
   FIREBASE DATA LAYER (Bid Gurgaon)

   Wraps Firestore behind the same shape main.js already expects
   from data.json: { site, developers[], channelPartners[], projects[] }.

   Expected Firestore collections (mirrors data.json 1:1, so migrating
   is just importing the arrays as documents — see FIREBASE_SETUP.md):
     developers/{docId}       fields: rank, id, name, rera, bidAmount,
                               bidCycle, since, logo, locality, tagline,
                               projects: [projectId, ...]
     channelPartners/{docId}  fields: rank, name, activeOn: [...],
                               reraChannel, since, bidAmount, bidCycle, phone
     projects/{docId}         fields: id, developerId, name, locality,
                               status, configs, sizeRange, priceRange, ...
     meta/site                fields: name, fullName, tagline, domain,
                               supportPhone  (optional — falls back to
                               data.json's "site" block if missing)

   Nothing here runs until js/firebase-config.js has real (non-"YOUR_...")
   values. Until then window.GGN_FIREBASE.enabled stays false and
   main.js quietly keeps reading data.json — the site never breaks
   because Firebase isn't set up yet.
================================================================= */
(function () {
  window.GGN_FIREBASE = { enabled: false };

  const cfg = window.FIREBASE_CONFIG;
  const isConfigured = cfg && cfg.apiKey && !String(cfg.apiKey).startsWith('YOUR_');
  if (!isConfigured) return;
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK scripts did not load — check network/CDN access.');
    return;
  }

  try {
    firebase.initializeApp(cfg);
    const db = firebase.firestore();

    // Admin pages still need Firebase Authentication even when public pages
    // intentionally read the reviewed static data.json. Only expose the live
    // Firestore data source when a deployment explicitly opts into it.
    if (window.GGN_DATA_SOURCE !== 'firestore') {
      window.GGN_FIREBASE = { enabled: false, db };
      return;
    }

    async function fetchData() {
      // No orderBy('rank') on the board collections: Firestore silently drops
      // documents that are missing the field you order by, so a developer
      // saved without a rank vanished from the site entirely (three developer
      // and two partner records are in exactly that state right now). Read
      // everything and let js/market.js derive position from bidAmount — the
      // authoritative figure — and classify the rest as "not on the board".
      const [devSnap, cpSnap, projSnap, siteSnap] = await Promise.all([
        db.collection('developers').get(),
        db.collection('channelPartners').get(),
        db.collection('projects').get(),
        db.collection('meta').doc('site').get().catch(() => null)
      ]);
      return {
        site: siteSnap && siteSnap.exists ? siteSnap.data() : {},
        developers: devSnap.docs.map(d => ({ docId: d.id, ...d.data() })),
        channelPartners: cpSnap.docs.map(d => ({ docId: d.id, ...d.data() })),
        projects: projSnap.docs.map(d => ({ docId: d.id, ...d.data() }))
      };
    }

    /* Generic realtime subscription used by main.js to keep boards live —
       returns an unsubscribe function in case a page ever wants to stop it.
       Unordered for the same reason as fetchData(): ordering server-side on a
       hand-typed field would hide records instead of ranking them.

       includeMetadataChanges is on deliberately. Without it, a dropped
       connection is invisible: Firestore keeps retrying the Listen stream and
       never calls the error handler, so a "LIVE" pill would keep claiming a
       live market long after the tab went offline. With it, we get a
       metadata-only snapshot the moment the SDK starts serving from its local
       cache instead of the server, and `meta.fromCache` lets the caller
       downgrade the pill to CACHED honestly. The error handler still fires for
       real failures (permission denied, listener torn down). */
    function onCollectionChange(collectionName, callback, onError) {
      return db.collection(collectionName).onSnapshot(
        { includeMetadataChanges: true },
        (snap) => callback(
          snap.docs.map(d => ({ docId: d.id, ...d.data() })),
          { fromCache: !!(snap.metadata && snap.metadata.fromCache) }
        ),
        (err) => {
          console.warn(`Firestore live listener failed for ${collectionName}`, err);
          if (typeof onError === 'function') onError(err);
        }
      );
    }

    window.GGN_FIREBASE = { enabled: true, db, fetchData, onCollectionChange };
  } catch (e) {
    console.warn('Firebase init failed — falling back to data.json', e);
    window.GGN_FIREBASE = { enabled: false };
  }
})();
