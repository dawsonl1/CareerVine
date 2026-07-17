// Global test setup
// Add any shared mocks or configuration here

// CAR-149: the shared QStash verifier (src/lib/qstash-verify.ts) refuses (401)
// when the signing keys are unset — before invoking the (mocked) Receiver. Cron
// route tests mock `@upstash/qstash`'s Receiver to accept, so they need the keys
// present or every route would 401 before their mock runs. Dummy values are
// fine: the Receiver itself is mocked in those suites.
process.env.QSTASH_CURRENT_SIGNING_KEY ||= "test-current-signing-key";
process.env.QSTASH_NEXT_SIGNING_KEY ||= "test-next-signing-key";
