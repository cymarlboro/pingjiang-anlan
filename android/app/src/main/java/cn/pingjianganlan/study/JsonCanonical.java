package cn.pingjianganlan.study;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

/**
 * Stable JSON text for order-insensitive comparisons. Object keys are sorted,
 * arrays keep their original order. Used only for deterministic local merge
 * decisions; it is never exposed to JavaScript.
 */
final class JsonCanonical {
    private JsonCanonical() {
    }

    static String of(Object value) {
        StringBuilder builder = new StringBuilder();
        append(builder, value);
        return builder.toString();
    }

    private static void append(StringBuilder builder, Object value) {
        if (value == null || value == JSONObject.NULL) {
            builder.append("null");
        } else if (value instanceof JSONObject) {
            appendObject(builder, (JSONObject) value);
        } else if (value instanceof JSONArray) {
            appendArray(builder, (JSONArray) value);
        } else if (value instanceof String) {
            builder.append(JSONObject.quote((String) value));
        } else if (value instanceof Boolean) {
            builder.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Number) {
            appendNumber(builder, (Number) value);
        } else {
            builder.append(JSONObject.quote(String.valueOf(value)));
        }
    }

    private static void appendObject(StringBuilder builder, JSONObject object) {
        List<String> keys = new ArrayList<>();
        for (Iterator<String> iterator = object.keys(); iterator.hasNext(); ) {
            keys.add(iterator.next());
        }
        Collections.sort(keys);
        builder.append('{');
        boolean first = true;
        for (String key : keys) {
            if (!first) {
                builder.append(',');
            }
            first = false;
            builder.append(JSONObject.quote(key)).append(':');
            append(builder, object.opt(key));
        }
        builder.append('}');
    }

    private static void appendArray(StringBuilder builder, JSONArray array) {
        builder.append('[');
        for (int index = 0; index < array.length(); index++) {
            if (index > 0) {
                builder.append(',');
            }
            append(builder, array.opt(index));
        }
        builder.append(']');
    }

    private static void appendNumber(StringBuilder builder, Number number) {
        double value = number.doubleValue();
        if (Double.isFinite(value) && value == Math.rint(value) &&
            value >= Long.MIN_VALUE && value <= Long.MAX_VALUE) {
            builder.append(number.longValue());
        } else if (Double.isFinite(value)) {
            builder.append(number.toString());
        } else {
            builder.append("null");
        }
    }
}
