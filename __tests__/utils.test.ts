import loadModule from "../src/utils/load-module";
import { fixture } from "./helpers";
import { mm, getExtractedMap, getInlineMap, stripMap } from "../src/utils/sourcemap";

describe("load-module", () => {
  test("wrong path", async () => {
    const wrong = await loadModule("totallyWRONGPATH/here");
    expect(wrong).toBeUndefined();
  });

  test("correct cwd path", async () => {
    const correct = await loadModule(fixture("utils/fixture"));
    expect(correct).toBe("this is fixture");
  });

  test("correct path with custom basepath", async () => {
    const correct = await loadModule("fixture", fixture("utils"));
    expect(correct).toBe("this is fixture");
  });
});

describe("sourcemap-utils", () => {
  test("inline map", () => {
    let code = ".foo {color: red;}";
    const wrongMap = getInlineMap(code);
    expect(wrongMap).toBeUndefined();
    code +=
      "/*# sourceMappingURL=data:application/json;base64,e1RISVM6SVNBU09VUkNFTUFQU0lNVUxBVElPTn0= */";
    const correctMap = getInlineMap(code);
    expect(correctMap).toBe("{THIS:ISASOURCEMAPSIMULATION}");
  });

  test("file map", async () => {
    const code = ".foo {color: red;}/*# sourceMappingURL=fixture.css.map */";
    const wrongMap = await getExtractedMap(code, "this/is/nonexistant/path.css");
    expect(wrongMap).toBeUndefined();
    const correctMap = await getExtractedMap(code, fixture("utils/pointless.css"));
    expect(correctMap).toBe("{THIS:ISASOURCEMAPSIMULATION}");
  });

  test("strip map", () => {
    const code = ".foo {color: red;}/*# sourceMappingURL=fixture.css.map */";
    expect(stripMap(code)).toBe(".foo {color: red;}");
  });

  test("map modifier", () => {
    const map = JSON.stringify({ sources: ["../a/b/../foo/bar.css", "../b/a/../bar/foo.css"] });
    const relativeSrc = JSON.stringify(mm(map).relative().toObject()?.sources);
    expect(relativeSrc).toBe(JSON.stringify(["../a/foo/bar.css", "../b/bar/foo.css"]));
  });
});
