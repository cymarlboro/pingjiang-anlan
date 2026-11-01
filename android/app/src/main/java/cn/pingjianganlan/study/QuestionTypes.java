package cn.pingjianganlan.study;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Canonical question types and aliases shared with the preview UI. */
public final class QuestionTypes {
    public static final List<String> CANONICAL = Collections.unmodifiableList(Arrays.asList(
        "简答题",
        "名词解释",
        "论述题",
        "读图分析题",
        "填空题",
        "判断题",
        "选择题",
        "分类与配对题"
    ));

    private QuestionTypes() {
    }

    /** Returns a canonical type or null. Unknown types are never passed through. */
    public static String normalize(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.replaceAll("[\\s\\u3000]+", "");
        if (value.isEmpty()) {
            return null;
        }
        switch (value) {
            case "简答":
            case "简答题":
            case "简述题":
                return "简答题";
            case "名词":
            case "名词解释":
                return "名词解释";
            case "论述":
            case "论述题":
                return "论述题";
            case "读图与分析题":
            case "读图分析":
            case "读图分析题":
            case "读图题":
            case "图题":
            case "图表分析题":
                return "读图分析题";
            case "填空":
            case "填空题":
                return "填空题";
            case "判断":
            case "判断题":
                return "判断题";
            case "选择":
            case "选择题":
            case "单项选择":
            case "单项选择题":
            case "单选题":
                return "选择题";
            case "分类与配对题":
            case "分类题":
            case "配对题":
                return "分类与配对题";
            default:
                return null;
        }
    }

    public static boolean isCanonical(String type) {
        return type != null && CANONICAL.contains(type);
    }
}
