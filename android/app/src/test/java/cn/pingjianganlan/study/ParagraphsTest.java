package cn.pingjianganlan.study;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class ParagraphsTest {
    @Test
    public void retainsParagraphNumbersInLocators() {
        List<Paragraphs.Block> blocks = Paragraphs.fromText(
            "第一段内容。\n\n第二段内容。\n\n第三段内容。", 4000);
        assertEquals(3, blocks.size());
        assertEquals(0, blocks.get(0).getPageIndex());
        assertEquals(1, blocks.get(0).getParagraphNumber());
        assertEquals("第1段", blocks.get(0).getLocator());
        assertEquals("第3段", blocks.get(2).getLocator());
    }

    @Test
    public void longParagraphIsSplitWithPartLocators() {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < 600; index++) {
            builder.append("自然地理学综合题。");
        }
        List<Paragraphs.Block> blocks = Paragraphs.fromText(builder.toString(), 300);
        assertTrue(blocks.size() > 1);
        assertTrue(blocks.get(0).getLocator().startsWith("第1段（第1部分）"));
        assertTrue(blocks.get(1).getLocator().startsWith("第1段（第2部分）"));
        for (Paragraphs.Block block : blocks) {
            assertTrue(block.getText().length() <= 300);
        }
    }

    @Test
    public void blankParagraphIsNotReturned() {
        List<Paragraphs.Block> blocks = Paragraphs.fromText("\n\n有内容", 4000);
        assertEquals(1, blocks.size());
        assertEquals("第1段", blocks.get(0).getLocator());
        assertFalse(blocks.get(0).getText().isEmpty());
    }
}
