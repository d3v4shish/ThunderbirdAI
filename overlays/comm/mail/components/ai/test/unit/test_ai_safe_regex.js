/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { clearSafeRegexCacheForTests, compileSafeRegex, safeRegexTest } =
  ChromeUtils.importESModule(
    "moz-src:///comm/mail/components/ai/modules/AISafeRegex.sys.mjs"
  );

registerCleanupFunction(clearSafeRegexCacheForTests);

add_task(function test_compiles_and_reuses_bounded_safe_patterns() {
  const first = compileSafeRegex("^invoice\\s+[A-Z0-9-]+$", "iu");
  const second = compileSafeRegex("^invoice\\s+[A-Z0-9-]+$", "iu");
  Assert.ok(first.ok);
  Assert.equal(first.regex, second.regex, "compiled patterns are cached");
  Assert.ok(safeRegexTest("^invoice\\s+[A-Z0-9-]+$", "Invoice INV-42"));
});

add_task(function test_rejects_backtracking_and_backreference_patterns() {
  for (const pattern of ["(a+)+$", "(a|aa)+$", ".*alpha.*beta.*", "(a)\\1+"]) {
    const result = compileSafeRegex(pattern, "iu");
    Assert.ok(!result.ok, `${pattern} must be rejected: ${result.error}`);
    Assert.ok(!safeRegexTest(pattern, `${"a".repeat(20000)}!`));
  }
});

add_task(function test_allows_small_bounded_template_wildcards() {
  const pattern =
    "^invoice(?:[\\s\\p{P}]+)(?:\\S+(?:\\s+\\S+){0,11})(?:[\\s\\p{P}]+)review$";
  Assert.ok(compileSafeRegex(pattern, "iu").ok);
  Assert.ok(safeRegexTest(pattern, "Invoice INV-42 for Northwind review"));
  Assert.ok(
    !compileSafeRegex("(a+){0,200}", "iu").ok,
    "large bounded nested quantifiers remain unavailable"
  );
});

add_task(function test_bounds_input_before_matching() {
  Assert.ok(
    !safeRegexTest("needle$", `${"x".repeat(9000)}needle`),
    "content beyond the bounded matching surface is not evaluated"
  );
});

add_task(function test_matching_is_safe_for_malformed_external_values() {
  const malformedValue = {
    toString() {
      throw new Error("Unexpected value conversion");
    },
  };
  Assert.ok(
    !safeRegexTest("invoice", malformedValue),
    "a malformed condition input cannot abort mail analysis"
  );
});
