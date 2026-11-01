package cn.pingjianganlan.study;

import java.security.SecureRandom;

/**
 * Cryptographically random native content ids for cross-device first imports.
 *
 * <p>Existing sequential ids stay valid and unchanged. New questions, sources, and
 * imports use a value in {@code [10^12, 2^52)}, which is comfortably inside
 * JavaScript's {@code Number.MAX_SAFE_INTEGER}. The probability of two devices
 * choosing the same value is tiny, and callers still check every existing id again
 * before committing; a same-id/different-content cloud merge is refused rather than
 * overwriting local content.
 */
final class SecureIds {
    static final long MIN_RANDOM_ID = 1_000_000_000_000L;
    static final long MAX_RANDOM_ID_EXCLUSIVE = 1L << 52;

    private static final SecureRandom RANDOM = new SecureRandom();

    private SecureIds() {
    }

    static long randomId() {
        long span = MAX_RANDOM_ID_EXCLUSIVE - MIN_RANDOM_ID;
        long limit = Long.MAX_VALUE - (Long.MAX_VALUE % span);
        long value;
        do {
            value = RANDOM.nextLong() & Long.MAX_VALUE;
        } while (value >= limit);
        return MIN_RANDOM_ID + (value % span);
    }

    static boolean isInRange(long id) {
        return id >= MIN_RANDOM_ID && id < MAX_RANDOM_ID_EXCLUSIVE;
    }
}
