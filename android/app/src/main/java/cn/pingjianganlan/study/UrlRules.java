package cn.pingjianganlan.study;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * URL rules shared by API configuration, updates, and downloads.
 *
 * <p>These methods contain no Android types so they can be unit tested on the JVM.
 */
public final class UrlRules {
    private UrlRules() {
    }

    public static final class InvalidUrlException extends Exception {
        public InvalidUrlException(String message) {
            super(message);
        }
    }

    /**
     * Normalizes a chat-completions base URL. HTTPS may use any host but must not
     * contain userinfo, a query, or a fragment. Plain HTTP is accepted only for
     * localhost and 127.0.0.1. Trailing slashes and a pasted endpoint suffix are
     * removed so requests can append /models or /chat/completions consistently.
     */
    public static String normalizeApiBase(String raw) throws InvalidUrlException {
        String value = requireText(raw, 2048);
        URI uri = parse(value);
        String scheme = lower(uri.getScheme());
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            throw new InvalidUrlException("服务地址只允许 HTTPS；本地服务可使用 localhost/127.0.0.1 的 HTTP");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new InvalidUrlException("服务地址缺少有效主机名");
        }
        if (uri.getRawUserInfo() != null || uri.getUserInfo() != null) {
            throw new InvalidUrlException("服务地址不能包含用户名或密码");
        }
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new InvalidUrlException("服务地址不能包含查询参数或片段");
        }
        if ("http".equals(scheme) && !isLocalHost(host)) {
            throw new InvalidUrlException("HTTP 仅允许 localhost 或 127.0.0.1 本地服务");
        }
        String authority = uri.getRawAuthority();
        if (authority == null || authority.isEmpty()) {
            throw new InvalidUrlException("服务地址缺少主机");
        }
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        rejectTraversal(path);
        path = stripTrailingSlashes(path);
        if (path.endsWith("/chat/completions")) {
            path = path.substring(0, path.length() - "/chat/completions".length());
        } else if (path.endsWith("/models")) {
            path = path.substring(0, path.length() - "/models".length());
        }
        path = stripTrailingSlashes(path);
        String base = scheme + "://" + authority + path;
        if (base.length() > 2048) {
            throw new InvalidUrlException("服务地址过长");
        }
        return base;
    }

    /** Empty means "no update source configured"; otherwise this must be HTTPS. */
    public static String normalizeUpdateManifestUrl(String raw) throws InvalidUrlException {
        if (raw == null || raw.trim().isEmpty()) {
            return "";
        }
        return requireHttpsResource(raw.trim(), 4096);
    }

    public static String requireHttpsResource(String raw, int maxLength) throws InvalidUrlException {
        String value = requireText(raw, maxLength);
        URI uri = parse(value);
        if (!"https".equals(lower(uri.getScheme()))) {
            throw new InvalidUrlException("地址必须使用 HTTPS");
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            throw new InvalidUrlException("地址缺少有效主机名");
        }
        if (uri.getRawUserInfo() != null || uri.getUserInfo() != null) {
            throw new InvalidUrlException("地址不能包含用户名或密码");
        }
        if (uri.getRawFragment() != null) {
            throw new InvalidUrlException("地址不能包含片段");
        }
        return value;
    }

    public static boolean isLocalHost(String host) {
        if (host == null) {
            return false;
        }
        String value = host.toLowerCase(Locale.ROOT);
        return "localhost".equals(value) || "127.0.0.1".equals(value);
    }

    private static String requireText(String raw, int maxLength) throws InvalidUrlException {
        if (raw == null) {
            throw new InvalidUrlException("地址不能为空");
        }
        String value = raw.trim();
        if (value.isEmpty()) {
            throw new InvalidUrlException("地址不能为空");
        }
        if (value.length() > maxLength) {
            throw new InvalidUrlException("地址过长");
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 0x20 || character == 0x7f || Character.isWhitespace(character)) {
                throw new InvalidUrlException("地址不能包含空白或控制字符");
            }
        }
        return value;
    }

    private static URI parse(String value) throws InvalidUrlException {
        try {
            return new URI(value);
        } catch (URISyntaxException exception) {
            throw new InvalidUrlException("地址格式无效");
        }
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    private static String stripTrailingSlashes(String value) {
        String result = value;
        while (result.endsWith("/")) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }

    private static void rejectTraversal(String path) throws InvalidUrlException {
        if (path.isEmpty()) {
            return;
        }
        String[] segments = path.split("/", -1);
        for (String segment : segments) {
            if ("..".equals(segment) || ".".equals(segment)) {
                throw new InvalidUrlException("服务地址路径不能包含相对路径");
            }
        }
    }
}
