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
  const { name, username, password, role, depotCode, email } = request.data || {};

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
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new HttpsError("invalid-argument", "That doesn't look like a valid email address.");
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
  if (normalizedEmail) record.email = normalizedEmail;

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

/* ==================================================================== */
/* Helper: resolve the caller's satDepotManagerUsers account from their  */
/* own session pointer - never trusts a client-supplied userId, so a     */
/* forged/guessed userId can't be used to edit someone else's account.   */
/* ==================================================================== */
async function sdmResolveCallerAccount(callerUid) {
  const sessionSnap = await db.ref(`satDepotManagerSessions/${callerUid}`).get();
  if (!sessionSnap.exists()) {
    throw new HttpsError("failed-precondition", "No active session. Please log in again.");
  }
  const userId = sessionSnap.val().userId;
  const userSnap = await db.ref(`satDepotManagerUsers/${userId}`).get();
  if (!userSnap.exists() || userSnap.val().deleted) {
    throw new HttpsError("not-found", "Account not found. Please log in again.");
  }
  return { userId, user: userSnap.val() };
}

/* ==================================================================== */
/* 5. linkDepotForAssistant                                              */
/*    Adds a depotId to the caller's own depotIds and refreshes their    */
/*    session pointer to match, both via Admin SDK - replaces the        */
/*    direct-RTDB-write version of rememberDepotForAssistant now that     */
/*    satDepotManagerUsers/satDepotManagerSessions are client deny-all.   */
/* ==================================================================== */
exports.linkDepotForAssistant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to link a depot.");
  }
  const { depotId } = request.data || {};
  if (!depotId) {
    throw new HttpsError("invalid-argument", "depotId is required.");
  }

  const { userId, user } = await sdmResolveCallerAccount(request.auth.uid);
  if (user.role !== "ASSISTANT") {
    throw new HttpsError("permission-denied", "Only assistants can link depots.");
  }

  const depotIds = { ...(user.depotIds || {}), [depotId]: true };
  await db.ref(`satDepotManagerUsers/${userId}/depotIds/${depotId}`).set(true);
  await db.ref(`satDepotManagerSessions/${request.auth.uid}`).update({
    depotIds,
    loggedInAt: admin.database.ServerValue.TIMESTAMP,
  });

  return { depotIds };
});

/* ==================================================================== */
/* 6. unlinkDepotForAssistant                                           */
/*    Removes a depotId from the caller's own depotIds and refreshes    */
/*    their session pointer to match - the unlink counterpart to        */
/*    linkDepotForAssistant above.                                      */
/* ==================================================================== */
exports.unlinkDepotForAssistant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to unlink a depot.");
  }
  const { depotId } = request.data || {};
  if (!depotId) {
    throw new HttpsError("invalid-argument", "depotId is required.");
  }

  const { userId, user } = await sdmResolveCallerAccount(request.auth.uid);
  if (user.role !== "ASSISTANT") {
    throw new HttpsError("permission-denied", "Only assistants can unlink depots.");
  }

  const depotIds = { ...(user.depotIds || {}) };
  delete depotIds[depotId];
  await db.ref(`satDepotManagerUsers/${userId}/depotIds/${depotId}`).remove();
  await db.ref(`satDepotManagerSessions/${request.auth.uid}`).update({
    depotIds,
    loggedInAt: admin.database.ServerValue.TIMESTAMP,
  });

  return { depotIds };
});

/* ==================================================================== */
/* 7. transferClerkToDepot                                              */
/*    Moves a CLERK account's single depotId to a new depot. Called by  */
/*    an ASSISTANT who oversees both the clerk's current depot and the   */
/*    destination depot (i.e. both are in the assistant's own depotIds - */
/*    same identity-boundary reasoning as linkDepotForAssistant above:   */
/*    an assistant shouldn't be able to pull a clerk out of a depot they */
/*    have no oversight of, or drop them into one they don't manage).    */
/*                                                                        */
/*    Deliberately never touches satDepotManager/{depotId} - the actual  */
/*    depot data - at all, for either the old or new depot. This is what */
/*    keeps past records untouched: a clerk's depotId is just a pointer  */
/*    on their account (and a copy on their live session pointer(s));    */
/*    the depot's own stock/personnel/etc. data is stored under its own  */
/*    depotId regardless of which clerk is currently assigned there, so  */
/*    moving the pointer changes access, never data. The old depot's     */
/*    records remain exactly as they were, readable by whichever clerk   */
/*    (or assistant) is linked to that depotId afterward.                */
/*                                                                        */
/*    Also updates every live session pointer for this clerk (there may  */
/*    be more than one if they're logged in on multiple devices) in the  */
/*    same atomic multi-path update as the account record - otherwise a  */
/*    currently-logged-in clerk would keep old-depot access until their  */
/*    next login, since the RTDB rule checks the session pointer's own   */
/*    depotId copy, not the account record.                              */
/* ==================================================================== */
exports.transferClerkToDepot = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to transfer a clerk.");
  }
  const { clerkUserId, newDepotId } = request.data || {};
  if (!clerkUserId || !newDepotId) {
    throw new HttpsError("invalid-argument", "clerkUserId and newDepotId are required.");
  }
  const normalizedNewDepotId = newDepotId.trim().toUpperCase();
  if (!normalizedNewDepotId) {
    throw new HttpsError("invalid-argument", "newDepotId cannot be empty.");
  }

  const { user: caller } = await sdmResolveCallerAccount(request.auth.uid);
  if (caller.role !== "ASSISTANT") {
    throw new HttpsError("permission-denied", "Only assistants can transfer clerks between depots.");
  }

  const clerkSnap = await db.ref(`satDepotManagerUsers/${clerkUserId}`).get();
  if (!clerkSnap.exists() || clerkSnap.val().deleted) {
    throw new HttpsError("not-found", "Clerk account not found.");
  }
  const clerk = clerkSnap.val();
  if (clerk.role !== "CLERK") {
    throw new HttpsError("invalid-argument", "Target account is not a clerk.");
  }
  const oldDepotId = clerk.depotId || null;

  const callerDepotIds = caller.depotIds || {};
  if (!oldDepotId || !callerDepotIds[oldDepotId]) {
    throw new HttpsError(
      "permission-denied",
      "You must oversee the clerk's current depot to transfer them."
    );
  }
  if (!callerDepotIds[normalizedNewDepotId]) {
    throw new HttpsError(
      "permission-denied",
      "You must oversee the destination depot to transfer a clerk into it."
    );
  }

  if (oldDepotId === normalizedNewDepotId) {
    return { clerkUserId, oldDepotId, newDepotId: normalizedNewDepotId, sessionsUpdated: 0, noop: true };
  }

  // Find every live session pointer for this clerk (possibly more than
  // one device) so they can all be updated in the same atomic write as
  // the account record - see the function-level comment above.
  const sessionsSnap = await db
    .ref("satDepotManagerSessions")
    .orderByChild("userId")
    .equalTo(clerkUserId)
    .get();

  const updates = {};
  updates[`satDepotManagerUsers/${clerkUserId}/depotId`] = normalizedNewDepotId;
  let sessionsUpdated = 0;
  if (sessionsSnap.exists()) {
    sessionsSnap.forEach((child) => {
      updates[`satDepotManagerSessions/${child.key}/depotId`] = normalizedNewDepotId;
      updates[`satDepotManagerSessions/${child.key}/loggedInAt`] = admin.database.ServerValue.TIMESTAMP;
      sessionsUpdated++;
    });
  }
  await db.ref().update(updates);

  return { clerkUserId, oldDepotId, newDepotId: normalizedNewDepotId, sessionsUpdated };
});

/* ==================================================================== */
/* 8. listClerksInDepot                                                 */
/*    Returns the CLERK accounts currently pointing at a given depot,   */
/*    so an ASSISTANT's "Transfer Clerk" screen has something to pick   */
/*    from - satDepotManagerUsers is client deny-all, so there's no     */
/*    other way for the client to know which clerks exist there.        */
/*    Same oversight check as transferClerkToDepot: the caller must be  */
/*    an ASSISTANT with this depotId already in their own depotIds -    */
/*    an assistant shouldn't be able to enumerate clerks in a depot      */
/*    they have no oversight of.                                        */
/* ==================================================================== */
exports.listClerksInDepot = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to list clerks.");
  }
  const { depotId } = request.data || {};
  if (!depotId) {
    throw new HttpsError("invalid-argument", "depotId is required.");
  }
  const normalizedDepotId = depotId.trim().toUpperCase();

  const { user: caller } = await sdmResolveCallerAccount(request.auth.uid);
  if (caller.role !== "ASSISTANT") {
    throw new HttpsError("permission-denied", "Only assistants can list a depot's clerks.");
  }
  if (!(caller.depotIds || {})[normalizedDepotId]) {
    throw new HttpsError(
      "permission-denied",
      "You must oversee this depot to list its clerks."
    );
  }

  const snap = await db
    .ref("satDepotManagerUsers")
    .orderByChild("depotId")
    .equalTo(normalizedDepotId)
    .get();

  const clerks = [];
  if (snap.exists()) {
    snap.forEach((child) => {
      const val = child.val();
      if (val.role === "CLERK" && !val.deleted) {
        clerks.push({ userId: child.key, name: val.name, username: val.username });
      }
    });
  }
  return { clerks };
});

/* ==================================================================== */
/* 9. sdmSetRecoveryEmail                                               */
/*    Lets a logged-in user add or change the recovery email on their   */
/*    own account. Uses the same session-pointer resolution as the      */
/*    depot-linking functions above - never trusts a client-supplied    */
/*    userId, so nobody can set the email on someone else's account.    */
/* ==================================================================== */
exports.sdmSetRecoveryEmail = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to set a recovery email.");
  }
  const { email } = request.data || {};
  const normalizedEmail = (email || "").trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  }

  const { userId } = await sdmResolveCallerAccount(request.auth.uid);
  await db.ref(`satDepotManagerUsers/${userId}`).update({ email: normalizedEmail });

  return { email: normalizedEmail };
});

/* ==================================================================== */
/* 10. sdmResetPasswordWithEmail                                        */
/*     Looks up an account by username, and if the recovery email        */
/*     submitted matches the one on file (case-insensitive), sets the    */
/*     new password directly - no emailed code involved. Simpler, but     */
/*     note the tradeoff: anyone who knows both the username and the      */
/*     recovery email can reset that account's password, since nothing   */
/*     proves the caller actually owns that inbox. Acceptable for a       */
/*     small internal-team tool; revisit if that stops being true.       */
/*     Returns the same "no match" error whether the username or the     */
/*     email was wrong, so this can't be used to check which usernames    */
/*     exist or which email is on file for one.                          */
/* ==================================================================== */
exports.sdmResetPasswordWithEmail = onCall(async (request) => {
  const { username, recoveryEmail, newPassword } = request.data || {};
  const uname = (username || "").trim();
  const email = (recoveryEmail || "").trim().toLowerCase();
  if (!uname || !email || !newPassword) {
    throw new HttpsError("invalid-argument", "username, recoveryEmail and newPassword are required.");
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }

  const snap = await db
    .ref("satDepotManagerUsers")
    .orderByChild("username")
    .equalTo(uname)
    .limitToFirst(1)
    .get();

  const noMatch = () => new HttpsError("not-found", "Username and recovery email don't match our records.");
  if (!snap.exists()) throw noMatch();
  const [userId, user] = Object.entries(snap.val())[0];
  if (user.deleted || !user.email || user.email !== email) throw noMatch();

  const salt = sdmRandomSaltHex();
  const passwordHash = sdmHashPassword(newPassword, salt);
  await db.ref(`satDepotManagerUsers/${userId}`).update({ passwordHash, salt });

  // Password changed - log every device out so a device left signed in
  // elsewhere doesn't keep riding the old session.
  const sessionsSnap = await db
    .ref("satDepotManagerSessions")
    .orderByChild("userId")
    .equalTo(userId)
    .get();
  if (sessionsSnap.exists()) {
    const removals = {};
    sessionsSnap.forEach((child) => { removals[child.key] = null; });
    await db.ref("satDepotManagerSessions").update(removals);
  }

  return { status: "reset" };
});
