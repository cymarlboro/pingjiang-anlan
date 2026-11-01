package cn.pingjianganlan.study;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits plain text into stable, numbered blocks. Paragraph numbers are retained in
 * every locator; long paragraphs are cut at sentence boundaries with a part suffix.
 */
public final class Paragraphs {
    public static final int DEFAULT_MAX_CHARS = 4000;
    public static final int MAX_BLOCKS = 5000;

    public static final class Block {
        private final int pageIndex;
        private final int paragraphNumber;
        private final String locator;
        private final String text;

        Block(int pageIndex, int paragraphNumber, String locator, String text) {
            this.pageIndex = pageIndex;
            this.paragraphNumber = paragraphNumber;
            this.locator = locator;
            this.text = text;
        }

        public int getPageIndex() {
            return pageIndex;
        }

        public int getParagraphNumber() {
            return paragraphNumber;
        }

        public String getLocator() {
            return locator;
        }

        public String getText() {
            return text;
        }
    }

    private static final String BOUNDARIES = "。！？；.!?;\n";

    private Paragraphs() {
    }

    public static List<Block> fromText(String raw, int maxChars) {
        String text = TextRules.clean(raw);
        List<Block> result = new ArrayList<>();
        if (text.isEmpty()) {
            return result;
        }
        String[] paragraphs = text.split("\\n[\\t ]*\\n", -1);
        int pageIndex = 0;
        for (int paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
            String paragraph = paragraphs[paragraphIndex].trim();
            if (paragraph.isEmpty()) {
                continue;
            }
            int paragraphNumber = paragraphIndex + 1;
            List<String> chunks = chunk(paragraph, Math.max(200, maxChars));
            for (int chunkIndex = 0; chunkIndex < chunks.size(); chunkIndex++) {
                if (result.size() >= MAX_BLOCKS) {
                    return result;
                }
                String suffix = chunks.size() > 1
                    ? "（第" + (chunkIndex + 1) + "部分）"
                    : "";
                result.add(new Block(
                    pageIndex,
                    paragraphNumber,
                    "第" + paragraphNumber + "段" + suffix,
                    chunks.get(chunkIndex)
                ));
                pageIndex++;
            }
        }
        return result;
    }

    public static List<String> chunk(String paragraph, int maxChars) {
        List<String> result = new ArrayList<>();
        String remaining = paragraph == null ? "" : paragraph.trim();
        int limit = Math.max(200, maxChars);
        while (!remaining.isEmpty()) {
            if (remaining.length() <= limit) {
                result.add(remaining);
                break;
            }
            int cut = limit;
            int floor = Math.max(1, limit / 2);
            for (int index = limit; index >= floor; index--) {
                char character = remaining.charAt(index - 1);
                if (BOUNDARIES.indexOf(character) >= 0 || Character.isWhitespace(character)) {
                    cut = index;
                    break;
                }
            }
            String piece = remaining.substring(0, cut).trim();
            remaining = remaining.substring(cut).trim();
            if (!piece.isEmpty()) {
                result.add(piece);
            }
            if (result.size() > MAX_BLOCKS) {
                break;
            }
        }
        return result;
    }
}
