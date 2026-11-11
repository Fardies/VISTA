VISTA — Visitor Information & Smart Tracking Application
© 2026 CDC Technologies Sdn Bhd
Firebase-connected visitor registration and operator dashboard with face check-in.
START HERE: SETUP_FIREBASE.txt.
Face scanner now:  PROTOTYPE_TESTING.txt (local face matching, Spark plan).
Face scanner later: FACE_SETUP.txt (Cloud Functions, needs Blaze).
The included firestore.rules must be PUBLISHED (Console or firebase deploy).

Flow
  1. Visitor scans the QR code > Register Visit (status: Pending Check-In).
  2. Guard checks the visitor in: face scan or manual.
  3. Guard checks the visitor out: face scan or manual.
  All steps update the SAME record in the "visits" collection.

Files
  index.html / app.js        Visitor registration (QR page)
  guard.html / guard.js      Operator dashboard: Visitor Records + Face Scanner tabs
  face.js                    Human.js camera + face template (runs on the guard's phone)
  face-scanner.js            Face Scanner tab: check-in, check-out, confirm screens.
                             FACE_MODE at the top: 'local' (Spark) or 'cloud' (Blaze)
  face-local.js              Local mode: templates saved on the guard's phone only
  common.js                  Malaysia time formatting and input clean-up
  firebase-config.js         Firebase project settings (public web config)
  firestore.rules            Database security rules
  functions/                 Cloud Functions: encrypted template storage and matching
    index.js                   faceEnrollCheckIn, faceMatchCheckOut, faceConfirmCheckOut,
                               faceRelease, facePurge (hourly clean-up)
    lib.js                     similarity, encryption, validation, match tokens
    test/                      npm test
  firebase.json, .firebaserc Deploy settings (project vista-4292a)
  style.css                  Styles

Firestore collections
  visits/{id}          Visitor records (operator reads all; visitor reads own)
  faceTemplates/{id}   Encrypted face templates, same id as the visit.
                       NO browser access; Cloud Functions only.
  faceEvents/{id}      Face audit log: outcomes and scores, no face data.

Operator dashboard
  - Live clock; cards: Currently Inside, Pending Check-In, Checked Out, Total Visits
  - Today only by default; earlier visitors still inside are flagged
  - Register Walk-in Visitor (manual), Manual Check-In / Check-Out, Cancel Registration
  - Face Scanner tab: Scan Face (consenting visitors), Scan Face to Check Out
  - Export to Excel (Day / Week / Month / Year / All / Date Range)
