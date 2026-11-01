package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** JVM tests for the deterministic choice-option post-check shared with desktop. */
public class ApiClientChoiceValidationTest {
    private static final String STEM =
        "中国空间站轨道高度约400公里，位于大气圈的哪一层？";

    @Test
    public void realV040ChoiceWithoutQuestionOptionsIsRejected() {
        assertFalse(ApiClient.hasCompleteChoiceOptions(STEM));
    }

    @Test
    public void commonChineseInlineAndNewlineOptionsAreAccepted() {
        String[] valid = {
            STEM + "A. 对流层 B. 平流层 C. 中间层 D. 热层",
            STEM + "\nA、对流层\nB、平流层\nC、中间层\nD、热层",
            STEM + "A．对流层 B．平流层 C．中间层 D．热层",
            STEM + "A) 对流层 B) 平流层 C) 中间层 D) 热层",
            STEM + "A）对流层 B）平流层 C）中间层 D）热层",
            STEM + "（A）对流层（B）平流层（C）中间层（D）热层",
            STEM + "（A） 对流层\n（B） 平流层\n（C） 中间层\n（D） 热层",
            STEM + "A.对流层B.平流层C.中间层D.热层"
        };
        for (String question : valid) {
            assertTrue("Should accept options: " + question,
                ApiClient.hasCompleteChoiceOptions(question));
        }
    }

    @Test
    public void atLeastTwoDistinctNonEmptyOptionsAreRequired() {
        String[] invalid = {
            STEM + "A. 对流层",
            STEM + "A. 对流层 A. 平流层",
            STEM + "A.   B. 平流层",
            STEM + "A. 对流层 B."
        };
        for (String question : invalid) {
            assertFalse("Should reject incomplete options: " + question,
                ApiClient.hasCompleteChoiceOptions(question));
        }
    }

    @Test
    public void answerLabelsAndBodyLettersAreNotOptions() {
        String[] notOptions = {
            "A、B 两地气温差异的主要原因是？",
            "图A和图B所示的地貌类型有何差异？",
            "维生素A. 缺乏会导致哪种疾病？",
            "答案：D. 热层"
        };
        for (String question : notOptions) {
            assertFalse("Body letters must not be treated as options: " + question,
                ApiClient.hasCompleteChoiceOptions(question));
        }
    }

    @Test
    public void singleAndMultipleChoiceAliasesUseTheSameCanonicalType() {
        assertEquals("选择题", ApiClient.normalizeGeneratedType("单选"));
        assertEquals("选择题", ApiClient.normalizeGeneratedType("多选"));
        assertEquals("选择题", ApiClient.normalizeGeneratedType("多选题"));
        assertEquals("选择题", ApiClient.normalizeGeneratedType("多项选择题"));
        assertEquals("选择题", ApiClient.normalizeGeneratedType("选择题"));
        assertEquals("简答题", ApiClient.normalizeGeneratedType("简答题"));
    }

    @Test
    public void promptRequiresOptionsInsideQuestionBecauseThereIsNoOptionsField() {
        String prompt = ApiClient.buildSystemPrompt(5);
        assertTrue(prompt.contains("选项必须全部写在 question 字段内"));
        assertTrue(prompt.contains("当前没有 options 字段"));
        assertTrue(prompt.contains("至少包含 A、B 两条"));
        assertTrue(prompt.contains("原文没有选项时不得生成选择题"));
    }
}
