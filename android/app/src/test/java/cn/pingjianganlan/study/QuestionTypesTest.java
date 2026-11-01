package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class QuestionTypesTest {
    @Test
    public void normalizesAliasesToCanonicalTypes() {
        assertEquals("简答题", QuestionTypes.normalize("简述题"));
        assertEquals("名词解释", QuestionTypes.normalize("名词"));
        assertEquals("选择题", QuestionTypes.normalize("单选题"));
        assertEquals("读图分析题", QuestionTypes.normalize("图表分析题"));
        assertEquals("分类与配对题", QuestionTypes.normalize("配对题"));
    }

    @Test
    public void rejectsUnknownTypes() {
        assertNull(QuestionTypes.normalize("编程题"));
        assertNull(QuestionTypes.normalize(""));
        assertNull(QuestionTypes.normalize(null));
        assertFalse(QuestionTypes.isCanonical("编程题"));
    }

    @Test
    public void canonicalListContainsEightTypes() {
        assertEquals(8, QuestionTypes.CANONICAL.size());
        assertTrue(QuestionTypes.isCanonical("论述题"));
    }
}
