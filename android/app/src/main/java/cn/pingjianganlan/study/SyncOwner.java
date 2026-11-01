package cn.pingjianganlan.study;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Pure owner-id validation shared by the auth and native sync code.
 *
 * <p>The only owner id accepted for sync queries is the canonical UUID returned by
 * the verified Supabase {@code /user} response. This keeps the id safe to place in
 * a fixed URL query and prevents arbitrary query text from reaching the transport.
 */
final class SyncOwner {
    private static final Pattern UUID_PATTERN = Pattern.compile(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    private SyncOwner() {
    }

    static boolean isUuid(String value) {
        return value != null && UUID_PATTERN.matcher(value).matches();
    }

    static String normalize(String value) throws UserException {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!isUuid(normalized)) {
            throw new UserException("云端账户标识无效");
        }
        return normalized;
    }
}
