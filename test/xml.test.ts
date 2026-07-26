import { describe, expect, it } from "vitest";
import { decodeEntities, extractAll, extractAttr, extractFirst, stripBom, unwrapCdata } from "../src/lib/xml";

describe("stripBom", () => {
  it("removes a leading BOM and leaves clean strings alone", () => {
    expect(stripBom("﻿<?xml version=\"1.0\"?>")).toBe('<?xml version="1.0"?>');
    expect(stripBom("<rss/>")).toBe("<rss/>");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeEntities("Item 5.02 &amp; 9.01 &lt;b&gt; &quot;x&quot; &apos;y&apos;")).toBe(
      "Item 5.02 & 9.01 <b> \"x\" 'y'",
    );
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });
  it("decodes uppercase-hex references", () => {
    expect(decodeEntities("&#X42;")).toBe("B");
  });
  it("leaves unknown entities intact", () => {
    expect(decodeEntities("&nope;")).toBe("&nope;");
  });
  it("leaves out-of-range numeric references intact instead of throwing", () => {
    expect(decodeEntities("&#x110000;")).toBe("&#x110000;");
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
  });
});

describe("unwrapCdata", () => {
  it("unwraps CDATA sections (Fed RSS style)", () => {
    expect(unwrapCdata("<![CDATA[https://example.gov/a.htm]]>")).toBe("https://example.gov/a.htm");
    expect(unwrapCdata("plain")).toBe("plain");
  });
});

describe("extractAll / extractFirst / extractAttr", () => {
  const feed = `﻿<?xml version="1.0"?>
    <feed xmlns:ndaq="http://www.nasdaqtrader.com/">
      <entry><title>8-K - ACME CORP</title><updated>2026-07-24T17:30:36-04:00</updated></entry>
      <entry><title>4 - Person (Reporting)</title><updated>2026-07-24T21:59:37-04:00</updated></entry>
      <item><ndaq:IssueSymbol>STKH</ndaq:IssueSymbol><ndaq:HaltTime>19:50:00.000</ndaq:HaltTime></item>
      <link rel="alternate" href="https://www.sec.gov/Archives/x-index.htm"/>
    </feed>`;

  it("extracts repeated tags in order", () => {
    expect(extractAll(feed, "title")).toEqual(["8-K - ACME CORP", "4 - Person (Reporting)"]);
  });

  it("extracts namespaced tags by qualified name", () => {
    expect(extractFirst(feed, "ndaq:IssueSymbol")).toBe("STKH");
    expect(extractFirst(feed, "ndaq:HaltTime")).toBe("19:50:00.000");
  });

  it("returns null/empty for absent tags", () => {
    expect(extractFirst(feed, "nope")).toBeNull();
    expect(extractAll(feed, "nope")).toEqual([]);
  });

  it("reads attributes off self-closing tags", () => {
    expect(extractAttr(feed, "link", "href")).toBe("https://www.sec.gov/Archives/x-index.htm");
    expect(extractAttr(feed, "link", "rel")).toBe("alternate");
    expect(extractAttr(feed, "link", "missing")).toBeNull();
  });

  it("tolerates '>' inside quoted attribute values", () => {
    const doc = `<entry title="a>b">BODY</entry><link href="https://x.gov/a?q=1>2"/>`;
    expect(extractAll(doc, "entry")).toEqual(["BODY"]);
    expect(extractAttr(doc, "link", "href")).toBe("https://x.gov/a?q=1>2");
  });

  it("accepts single-quoted attribute values", () => {
    const doc = `<link href='https://y.gov/f.xml' rel="self"/>`;
    expect(extractAttr(doc, "link", "href")).toBe("https://y.gov/f.xml");
    expect(extractAttr(doc, "link", "rel")).toBe("self");
  });
});
