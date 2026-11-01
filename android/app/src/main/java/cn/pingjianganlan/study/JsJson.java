package cn.pingjianganlan.study;

import org.json.JSONObject;

/** Helpers for injecting JSON into JavaScript without string concatenation hazards. */
final class JsJson {
    private JsJson() {
    }

    static String quote(String value) {
        return JSONObject.quote(value == null ? "" : value);
    }

    static String objectLiteral(JSONObject object) {
        return escapeLineSeparators(object.toString());
    }

    static String escapeLineSeparators(String value) {
        return value.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
}
