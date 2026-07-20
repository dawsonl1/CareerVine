/**
 * ⚠️ FROZEN COMPATIBILITY BARREL — re-exports only (CAR-146).
 *
 * The query monolith that used to live here is split into domain modules
 * under src/lib/data/ (client seam in src/lib/data/client.ts). This file
 * exists so the existing importers keep compiling unchanged.
 *
 * Do NOT add functions or statements to this file. New queries go in the
 * matching src/lib/data/<domain>.ts module (or a new domain module there),
 * resolve their client via db() from src/lib/data/client, and follow the
 * must() read convention documented on that helper. New code should import
 * from src/lib/data/* directly rather than through this barrel.
 *
 * Deliberately NOT re-exported (internal to src/lib/data):
 * activateContacts, getContactsWithLastTouch, buildLastTouchMap,
 * getRecentCutoff.
 */

export {
  getContactEmailLookup,
  getContacts,
  getContactsStreamed,
  getContactById,
  createContact,
  updateContact,
  appendContactNote,
  getFreshJobChangeContactIds,
  deleteContact,
  uploadContactPhoto,
  removeContactPhoto,
  getEmailProvenance,
  markEmailVerified,
  getNetworkTierCounts,
  activateContact,
  getTags,
  createTag,
  findOrCreateCompany,
  addCompanyToContact,
  removeCompaniesFromContact,
  findOrCreateSchool,
  findOrCreateLocation,
  resolveManualCompanyLocation,
  addSchoolToContact,
  removeSchoolsFromContact,
  addEmailToContact,
  removeEmailsFromContact,
  addPhoneToContact,
  removePhonesFromContact,
  addTagToContact,
  removeTagFromContact,
  getContactTagNames,
} from "./data/contacts";

export {
  getInteractions,
  getAllInteractions,
  createInteraction,
  updateInteraction,
  deleteInteraction,
} from "./data/interactions";

export {
  getMeetings,
  getMeetingsForContact,
  createMeeting,
  updateMeeting,
  deleteMeeting,
  replaceContactsForMeeting,
  addContactsToMeeting,
  createTranscriptSegments,
  getTranscriptSegments,
  updateSpeakerContact,
  deleteTranscriptSegments,
} from "./data/meetings";

export {
  createActionItem,
  getActionItems,
  getActionItemsForMeeting,
  getActionItemsForContact,
  getCompletedActionItems,
  getCompletedActionItemsForContact,
  replaceContactsForActionItem,
  deleteActionItem,
  getOnboardingActionItemId,
  updateActionItem,
  snoozeActionItem,
} from "./data/action-items";

export {
  snoozeContact,
  skipContactFirstOutreach,
  setSuggestionCooldown,
  getRelationshipsOnTrack,
  getNetworkHealthSummary,
  getNeglectedContacts,
} from "./data/follow-ups";

export {
  getHomeCoreData,
  getActionListCounts,
  getNetworkingStreak,
  getHomeStats,
  getActivityHeatmap,
} from "./data/home";

export {
  uploadAttachment,
  addAttachmentToContact,
  addAttachmentToMeeting,
  getAttachmentsForContact,
  getAttachmentsForMeeting,
  getAttachmentUrl,
  deleteAttachment,
} from "./data/attachments";

export {
  getUserProfile,
  updateUserProfile,
  getDismissedGettingStarted,
  setDismissedGettingStarted,
  getGmailConnection,
} from "./data/users";
