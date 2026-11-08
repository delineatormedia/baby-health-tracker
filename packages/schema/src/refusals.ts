// Sign-in refusals the web client acts on rather than only shows (#5 step 3). The server
// answers with exactly these texts, and the client matches them to mint a new device id, so
// both import them from here. They are not wire schemas and do not change SCHEMA_VERSION.

/** 401 from a sign-in with a phone id a parent removed from the household. */
export const DEVICE_REMOVED = 'This phone was removed from the household';

/** 409 from a sign-in with a phone id another household holds. */
export const DEVICE_ELSEWHERE = 'This phone id belongs to another household';

/**
 * 409 from adding (or registering with) a baby that a clear deleted (#85). The phone asking
 * still holds that baby and its log from before the clear; it drops them and starts over.
 */
export const BABY_CLEARED = 'This baby was deleted when the household’s data was cleared';
