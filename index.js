/**
 * Nexlite Digital Solutions - Satellite Depot Manager
 * Cloud Functions: Account creation for Marketing Assistants and Depot Clerks
 *
 * Deploy with: firebase deploy --only functions
 * Requires: Blaze (pay-as-you-go) plan
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const db = admin.database();
const auth = admin.auth();

/* ------------------------------------------------------------------ */
/* Helper: generate a secure random temporary password for new clerks */
/* ------------------------------------------------------------------ */
function generateTempPassword() {
  // 16 random bytes -> base64, trimmed to 20 chars, guaranteed to satisfy
  // Firebase Auth's minimum 6-character requirement with room to spare.
  return crypto.randomBytes(16).toString("base64").slice(0, 20);
}

/* ==================================================================== */
/* 1. registerMarketingAssistant                                         */
/*    Called from the app's "Sign up as Marketing Assistant" screen.     */
/*    Requires a valid, unused, non-expired invite code tied to the      */
/*    submitted email. The invite code itself must already exist under  */
/*    /marketingAssistantInvites/{code} - you create these manually in  */
/*    the Firebase console (or a future admin page) with fields:         */
/*      { email: "person@example.com", used: false, expiresAt: <ms> }    */
/* ==================================================================== */
exports.registerMarketingAssistant = onCall(async (request) => {
  const { email, password, name, inviteCode } = request.data || {};

  if (!email || !password || !name || !inviteCode) {
    throw new HttpsError(
      "invalid-argument",
      "email, password, name and inviteCode are all required."
    );
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "Password must be at least 6 characters."
    );
  }

  const inviteRef = db.ref(`marketingAssistantInvites/${inviteCode}`);

  // Atomically claim the invite code first, before creating any Auth user.
  // This closes the race condition where two people submit the same code
  // at nearly the same time - only one transaction can win.
  const txResult = await inviteRef.transaction((current) => {
    if (current === null) {
      // Code does not exist - abort transaction, no changes.
      return; // returning undefined aborts
    }
    if (current.used === true) {
      return; // already used - abort
    }
    if (!current.expiresAt || current.expiresAt <= Date.now()) {
      return; // expired - abort
    }
    if (current.email !== email) {
      return; // code was issued for a different email - abort
    }
    // All checks pass - claim it.
    return { ...current, used: true, claimedAt: Date.now() };
  });

  if (!txResult.committed) {
    throw new HttpsError(
      "failed-precondition",
      "Invite code is invalid, expired, already used, or does not match this email."
    );
  }

  // Invite is now claimed. Create the Auth user.
  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
    });
  } catch (err) {
    // Roll back the invite claim so it can be retried, since account
    // creation failed (e.g. email already in use).
    await inviteRef.update({ used: false, claimedAt: null });
    throw new HttpsError(
      "already-exists",
      `Could not create account: ${err.message}`
    );
  }

  // Write the marketing assistant profile.
  try {
    await db.ref(`marketingAssistants/${userRecord.uid}`).set({
      role: "MARKETING_ASSISTANT",
      name,
      email,
      inviteCode,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (err) {
    // Profile write failed after Auth user was created - clean up the
    // orphaned Auth user so retrying doesn't hit "email already in use".
    await auth.deleteUser(userRecord.uid).catch(() => {});
    await inviteRef.update({ used: false, claimedAt: null });
    throw new HttpsError("internal", "Failed to save profile. Please retry.");
  }

  return { uid: userRecord.uid, status: "created" };
});

/* ==================================================================== */
/* 2. createClerk                                                        */
/*    Called from a logged-in Marketing Assistant's "Add Clerk" screen.  */
/*    Creates the clerk's Auth account under the hood (so the MA's own   */
/*    session is never disturbed), writes the DB records, and returns    */
/*    a password-reset link the MA can send to the clerk (WhatsApp,      */
/*    SMS, or email) so the clerk can set their own password and log in. */
/* ==================================================================== */
exports.createClerk = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "You must be logged in to create a clerk account."
    );
  }

  const callerUid = request.auth.uid;
  const { email, name, username, depotId } = request.data || {};

  if (!email || !name || !username || !depotId) {
    throw new HttpsError(
      "invalid-argument",
      "email, name, username and depotId are all required."
    );
  }

  // Confirm the caller is a real marketing assistant.
  const maSnap = await db.ref(`marketingAssistants/${callerUid}`).get();
  if (!maSnap.exists() || maSnap.child("role").val() !== "MARKETING_ASSISTANT") {
    throw new HttpsError(
      "permission-denied",
      "Only marketing assistants can create clerk accounts."
    );
  }

  // Create the clerk's Auth account with a throwaway temp password.
  // The clerk will never use this password - they'll set their own via
  // the reset link below.
  let clerkRecord;
  try {
    clerkRecord = await auth.createUser({
      email,
      password: generateTempPassword(),
      displayName: name,
    });
  } catch (err) {
    throw new HttpsError(
      "already-exists",
      `Could not create clerk account: ${err.message}`
    );
  }

  // Write clerk profile + owner pointer.
  try {
    await db.ref(`clerks/${callerUid}/${clerkRecord.uid}`).set({
      username,
      name,
      role: "SDC",
      depotId,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
    await db.ref(`userOwners/${clerkRecord.uid}`).set({
      ownerUid: callerUid,
    });
  } catch (err) {
    // Roll back the orphaned Auth user if the DB writes failed.
    await auth.deleteUser(clerkRecord.uid).catch(() => {});
    throw new HttpsError("internal", "Failed to save clerk profile. Please retry.");
  }

  // Generate the "set your password" link. The clerk opens this, sets a
  // real password, and from then on logs in normally with email + password.
  let resetLink;
  try {
    resetLink = await auth.generatePasswordResetLink(email);
  } catch (err) {
    // Account exists even if link generation failed - MA can retry
    // sending the invite separately without recreating the account.
    resetLink = null;
  }

  return {
    uid: clerkRecord.uid,
    status: "created",
    resetLink, // null if generation failed - surface a retry option in the app
  };
});

/* ====================================================================
   NOTE: the two functions above (registerMarketingAssistant, createClerk)
   target a different auth model than Satellite Depot Manager actually
   uses - real Firebase Auth accounts under marketingAssistants/clerks
   with MARKETING_ASSISTANT/SDC roles. Satellite Depot Manager's client
   (AppAuth in index.html) uses anonymous Firebase Auth plus its own
   satDepotManagerUsers table with CLERK/ASSISTANT roles instead. Left in
   place in case another app in this project still calls them, but they
   are not part of Satellite Depot Manager's login flow - the functions
   below are the ones that flow actually uses.
   ==================================================================== */

/* ------------------------------------------------------------------ */
/* Helper: PBKDF2-SHA256 password hashing, matching the client's       */
/* WebCrypto implementation in index.html exactly (100k iterations,    */
/* 32-byte output, hex-encoded salt/hash) so a record written by either */
/* side verifies identically on the other.                             */
/* ------------------------------------------------------------------ */
const SDM_PBKDF2_ITERATIONS = 100000;

function sdmHashPassword(password, saltHex) {
  return crypto
    .pbkdf2Sync(password, Buffer.from(saltHex, "hex"), SDM_PBKDF2_ITERATIONS, 32, "sha256")
    .toString("hex");
}

function sdmRandomSaltHex() {
  return crypto.randomBytes(16).toString("hex");
}

/* ==================================================================== */
/* 3. sdmLogin                                                           */
/*    Verifies a Satellite Depot Manager username/password server-side   */
/*    (via the Admin SDK, which bypasses RTDB rules) and writes the      */
/*    session pointer - so satDepotManagerUsers no longer needs a broad  */
/*    client-readable rule at all; only this function ever reads it.     */
/*    The client must already be signed in anonymously (request.auth)    */
/*    before calling this, since the session pointer is keyed by that    */
/*    UID exactly as it is in the client's own _refreshServerSession().  */
/* ==================================================================== */
exports.sdmLogin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Anonymous sign-in must complete before logging in."
    );
  }
  const { username, password } = request.data || {};
  if (!username || !password) {
    throw new HttpsError("invalid-argument", "username and password are required.");
  }

  const snap = await db
    .ref("satDepotManagerUsers")
    .orderByChild("username")
    .equalTo(username)
    .limitToFirst(1)
    .get();

  if (!snap.exists()) {
    throw new HttpsError("not-found", "No account found with that username.");
  }
  const [id, user] = Object.entries(snap.val())[0];
  if (user.deleted) {
    throw new HttpsError("not-found", "No account found with that username.");
  }

  let ok = false;
  if (user.passwordHash && user.salt) {
    ok = sdmHashPassword(password, user.salt) === user.passwordHash;
  } else if (user.password !== undefined) {
    // Legacy plaintext record - verify the old way, then migrate it to a
    // hash right now so a successful login is also the moment plaintext
    // stops existing for this account. Same migrate-on-login approach as
    // the client fallback, just server-side now.
    ok = user.password === password;
    if (ok) {
      const salt = sdmRandomSaltHex();
      const passwordHash = sdmHashPassword(password, salt);
      await db.ref(`satDepotManagerUsers/${id}`).update({
        passwordHash,
        salt,
        password: null,
      });
    }
  }
  if (!ok) {
    throw new HttpsError("permission-denied", "Incorrect password.");
  }

  await db.ref(`satDepotManagerSessions/${request.auth.uid}`).set({
    userId: id,
    role: user.role,
    depotId: user.depotId || null,
    depotIds: user.depotIds || {},
    loggedInAt: admin.database.ServerValue.TIMESTAMP,
  });

  return {
    userId: id,
    username: user.username,
    name: user.name,
    role: user.role,
    depotId: user.depotId || null,
    depotIds: user.depotIds || {},
  };
});

/* ==================================================================== */
/* 4. sdmSignup                                                          */
/*    Creates a new Satellite Depot Manager account (CLERK or ASSISTANT) */
/*    server-side - the password is hashed before it ever reaches the    */
/*    DB - and writes the session pointer for the caller's anonymous UID */
/*    so they're logged in immediately after signup.                     */
/* ==================================================================== */
exports.sdmSignup = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Anonymous sign-in must complete before signing up."
    );
  }
  const { name, username, password, role, depotCode } = request.data || {};

  if (!name || !username || !password || !role) {
    throw new HttpsError(
      "invalid-argument",
      "name, username, password and role are all required."
    );
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "Password must be at least 6 characters."
    );
  }
  if (role !== "CLERK" && role !== "ASSISTANT") {
    throw new HttpsError("invalid-argument", "role must be CLERK or ASSISTANT.");
  }
  if (role === "CLERK" && !(depotCode || "").trim()) {
    throw new HttpsError("invalid-argument", "Enter the depot code your depot uses.");
  }

  const existingSnap = await db
    .ref("satDepotManagerUsers")
    .orderByChild("username")
    .equalTo(username)
    .limitToFirst(1)
    .get();
  if (existingSnap.exists()) {
    const [, existing] = Object.entries(existingSnap.val())[0];
    if (!existing.deleted) {
      throw new HttpsError("already-exists", "That username is already taken.");
    }
  }

  const salt = sdmRandomSaltHex();
  const passwordHash = sdmHashPassword(password, salt);
  const record = {
    name,
    username,
    passwordHash,
    salt,
    role,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  };
  if (role === "CLERK") record.depotId = depotCode.trim().toUpperCase();
  else record.depotIds = {};

  const newRef = await db.ref("satDepotManagerUsers").push(record);

  await db.ref(`satDepotManagerSessions/${request.auth.uid}`).set({
    userId: newRef.key,
    role,
    depotId: record.depotId || null,
    depotIds: record.depotIds || {},
    loggedInAt: admin.database.ServerValue.TIMESTAMP,
  });

  return {
    userId: newRef.key,
    username,
    name,
    role,
    depotId: record.depotId || null,
    depotIds: record.depotIds || {},
  };
});
