package cn.pingjianganlan.study;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;

public class TextRulesTest {
    @Test
    public void acceptsChineseOcrTextAndRejectsNoise() {
        assertTrue(TextRules.isUsableOcrText("岩石圈由地壳和上地幔顶部组成。"));
        assertFalse(TextRules.isUsableOcrText(""));
        assertFalse(TextRules.isUsableOcrText("� � �"));
        assertFalse(TextRules.isUsableOcrText("||||||"));
        assertFalse(TextRules.isUsableOcrText("{}[]¥%&*"));
    }

    @Test
    public void shortTextLayerIsFlaggedForOcr() {
        assertFalse(TextRules.hasSufficientTextLayer("第 3 页"));
        assertTrue(TextRules.hasSufficientTextLayer(
            "自然地理学研究地球表层自然系统的组成、结构与相互作用。"));
    }

    @Test
    public void stripsScriptsStylesAndHeadBeforeHtmlParsing() {
        String html = "<html><head><title>secret</title><style>.x{color:red}</style></head>"
            + "<body><script>stealEverything()</script><p>岩浆岩</p><noscript>no</noscript>"
            + "<template>hidden</template></body></html>";
        String stripped = TextRules.stripActiveHtml(html);
        assertFalse(stripped.contains("stealEverything"));
        assertFalse(stripped.contains("color:red"));
        assertFalse(stripped.contains("secret"));
        assertFalse(stripped.contains("hidden"));
        assertTrue(stripped.contains("岩浆岩"));
    }

    @Test
    public void rejectsDoctypeAndEntityDeclarations() {
        assertTrue(TextRules.containsDoctypeOrEntity("<!DOCTYPE foo [ <!ENTITY x \"y\"> ]>"));
        assertFalse(TextRules.containsDoctypeOrEntity("<w:document>text</w:document>"));
    }

    @Test
    public void strictUtf8DecodingRejectsMalformedBytes() {
        try {
            TextRules.decodeUtf8(new byte[]{(byte) 0xC3, (byte) 0x28});
            fail("Expected malformed UTF-8 failure");
        } catch (CharacterCodingException expected) {
            // Expected.
        }
        try {
            assertEquals("山川记", TextRules.decodeUtf8(
                "山川记".getBytes(StandardCharsets.UTF_8)));
        } catch (CharacterCodingException exception) {
            fail("Valid UTF-8 was rejected");
        }
    }

    @Test
    public void reminderTimeValidationIsStrict() {
        assertTrue(TextRules.isValidReminderTime("00:00"));
        assertTrue(TextRules.isValidReminderTime("23:59"));
        assertFalse(TextRules.isValidReminderTime("24:00"));
        assertFalse(TextRules.isValidReminderTime("9:30"));
        assertFalse(TextRules.isValidReminderTime("20:60"));
    }
}
