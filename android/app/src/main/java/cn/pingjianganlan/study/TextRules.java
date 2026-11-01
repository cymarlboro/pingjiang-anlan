package cn.pingjianganlan.study;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Pure text rules used by importers, OCR, backups, and reminders. */
public final class TextRules {
    private static final Pattern SCRIPT = Pattern.compile("(?is)<script\\b[^>]*>.*?</script\\s*>");
    private static final Pattern STYLE = Pattern.compile("(?is)<style\\b[^>]*>.*?</style\\s*>");
    private static final Pattern NOSCRIPT = Pattern.compile("(?is)<noscript\\b[^>]*>.*?</noscript\\s*>");
    private static final Pattern TEMPLATE = Pattern.compile("(?is)<template\\b[^>]*>.*?</template\\s*>");
    private static final Pattern HEAD = Pattern.compile("(?is)<head\\b[^>]*>.*?</head\\s*>");
    private static final Pattern COMMENT = Pattern.compile("(?s)<!--.*?-->");
    private static final Pattern DOCTYPE = Pattern.compile("(?is)<!DOCTYPE[^>]*>");
    private static final Pattern XML_DECL = Pattern.compile("(?is)<\\?xml[^>]*\\?>");
    private static final Pattern BREAK = Pattern.compile("(?i)<br\\s*/?>");
    private static final Pattern BLOCK_END = Pattern.compile(
        "(?i)</(?:p|div|li|tr|td|th|h[1-6]|section|article|blockquote|table|ul|ol|dl|dt|dd)\\s*>");
    private static final Pattern TIME = Pattern.compile("^([01]\\d|2[0-3]):([0-5]\\d)$");

    private TextRules() {
    }

    public static String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String normalized = raw.replace("\r\n", "\n").replace('\r', '\n');
        StringBuilder builder = new StringBuilder(normalized.length());
        for (int index = 0; index < normalized.length(); index++) {
            char character = normalized.charAt(index);
            if (character == '\n' || character == '\t') {
                builder.append(character);
            } else if (character == '\u0000' || character == '\uFEFF') {
                // Drop NUL and byte-order marks.
            } else if (character < 0x20 || character == 0x7f) {
                builder.append(' ');
            } else if (character >= 0xE000 && character <= 0xF8FF) {
                // Private-use code points are usually broken font mappings.
                builder.append(' ');
            } else {
                builder.append(character);
            }
        }
        return builder.toString().trim();
    }

    public static int meaningfulCount(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        int count = 0;
        int index = 0;
        while (index < text.length()) {
            int codePoint = text.codePointAt(index);
            if (Character.isLetter(codePoint) || Character.isDigit(codePoint)) {
                count++;
            }
            index += Character.charCount(codePoint);
        }
        return count;
    }

    /** A PDF page with fewer than 20 letters/digits is considered to have little text. */
    public static boolean hasSufficientTextLayer(String text) {
        return meaningfulCount(clean(text)) >= 20;
    }

    /**
     * Rejects empty output and obvious OCR noise. A page is accepted only when it
     * has several letters/digits, a reasonable signal-to-noise ratio, no Unicode
     * replacement characters, and no runs of control/private-use code points.
     */
    public static boolean isUsableOcrText(String text) {
        String value = clean(text);
        if (value.isEmpty()) {
            return false;
        }
        int meaningful = meaningfulCount(value);
        if (meaningful < 4) {
            return false;
        }
        int nonWhitespace = 0;
        int bad = 0;
        int index = 0;
        while (index < value.length()) {
            int codePoint = value.codePointAt(index);
            if (!Character.isWhitespace(codePoint)) {
                nonWhitespace++;
                if (codePoint == 0xFFFD || Character.isISOControl(codePoint) ||
                    (codePoint >= 0xE000 && codePoint <= 0xF8FF)) {
                    bad++;
                }
            }
            index += Character.charCount(codePoint);
        }
        if (bad > 0 || nonWhitespace == 0) {
            return false;
        }
        return ((double) meaningful / (double) nonWhitespace) >= 0.5d;
    }

    public static boolean isValidReminderTime(String time) {
        return time != null && TIME.matcher(time).matches();
    }

    public static String decodeUtf8(byte[] bytes) throws CharacterCodingException {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
        CharBuffer decoded = decoder.decode(ByteBuffer.wrap(bytes));
        String value = decoded.toString();
        if (!value.isEmpty() && value.charAt(0) == '\uFEFF') {
            value = value.substring(1);
        }
        return value;
    }

    /**
     * Removes executable/meta HTML blocks before Android's Html.fromHtml is used.
     * The extractor never renders or loads anything from the document.
     */
    public static String stripActiveHtml(String html) {
        if (html == null) {
            return "";
        }
        String value = html;
        value = COMMENT.matcher(value).replaceAll("");
        value = SCRIPT.matcher(value).replaceAll("");
        value = STYLE.matcher(value).replaceAll("");
        value = NOSCRIPT.matcher(value).replaceAll("");
        value = TEMPLATE.matcher(value).replaceAll("");
        value = HEAD.matcher(value).replaceAll("");
        value = DOCTYPE.matcher(value).replaceAll("");
        value = XML_DECL.matcher(value).replaceAll("");
        value = BREAK.matcher(value).replaceAll("\n");
        value = BLOCK_END.matcher(value).replaceAll("\n");
        return value;
    }

    public static boolean containsDoctypeOrEntity(String xmlHead) {
        if (xmlHead == null) {
            return false;
        }
        String upper = xmlHead.toUpperCase(Locale.ROOT);
        return upper.contains("<!DOCTYPE") || upper.contains("<!ENTITY");
    }
}
