/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { Drain3TemplateMiner, mineDrain3Template } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AIDrain3.sys.mjs"
);
const { AITemplates } = ChromeUtils.importESModule(
  "moz-src:///comm/mail/components/ai/modules/AITemplates.sys.mjs"
);

add_task(function test_mines_variable_tokens_into_a_stable_template() {
  const result = mineDrain3Template([
    "Invoice 4107 review",
    "Invoice 4108 review",
    "Invoice 4109 review",
  ]);

  Assert.equal(result.template, "invoice <*> review");
  Assert.equal(result.observations, 3);
  Assert.ok(new RegExp(result.regex, "i").test("Invoice 9999 review"));
  Assert.ok(!new RegExp(result.regex, "i").test("Invoice review now"));
});

add_task(function test_keeps_unrelated_subjects_in_separate_clusters() {
  const miner = new Drain3TemplateMiner();
  const invoice = miner.observe("Invoice 4107 review");
  const flight = miner.observe("Flight 1821 confirmation");

  Assert.notEqual(invoice.id, flight.id);
});

add_task(function test_does_not_wildcard_ordinary_hyphenated_words() {
  const miner = new Drain3TemplateMiner();
  const security = miner.observe("Security-update available");
  const customer = miner.observe("Customer-notice available");

  Assert.notEqual(
    security.id,
    customer.id,
    "normal hyphenated words must remain constants instead of fake IDs"
  );
  Assert.equal(security.template, "security-update available");
});

add_task(function test_mines_bounded_variable_length_gaps() {
  const result = mineDrain3Template([
    "Invoice 4107 is ready for review",
    "Invoice INV-4108 for Northwind is ready for review",
    "Invoice 4109 from Contoso Europe is ready for review",
  ]);

  Assert.ok(result.template.startsWith("invoice <*>"));
  Assert.ok(
    new RegExp(result.regex, "iu").test("Invoice 9999 is ready for review")
  );
  Assert.ok(
    new RegExp(result.regex, "iu").test(
      "Invoice INV-44 for Adventure Works is ready for review"
    )
  );
});

add_task(function test_evicts_the_least_useful_cluster_at_the_bound() {
  const miner = new Drain3TemplateMiner({ maxClusters: 2 });
  const frequent = miner.observe("Invoice 4107 review");
  miner.observe("Invoice 4108 review");
  const disposable = miner.observe("Flight 1821 confirmation");
  const replacement = miner.observe("Security alert password changed");

  Assert.notEqual(replacement.id, disposable.id);
  Assert.equal(
    miner.observe("Invoice 4109 review").id,
    frequent.id,
    "the repeatedly observed cluster survives eviction"
  );
});

add_task(
  function test_template_mines_a_meaningful_body_surface_not_footer_or_quote() {
    const messages = [4107, 4108, 4109].map(invoice => ({
      author: "Billing <billing@example.com>",
      subject: `Invoice ${invoice} review`,
      body: [
        `Invoice ${invoice} amount 225 INR is ready for review.`,
        "Please verify the payment record.",
        "-- ",
        "Billing operations",
        "> quoted reply must not influence the template",
        "Unsubscribe from these notices.",
      ].join("\n"),
    }));

    const template = AITemplates.createTemplateFromMessages(messages, {
      createdFrom: "suggested",
    });
    Assert.equal(template.match.body.mode, "regex");
    Assert.ok(template.match.body.value.includes("invoice"));
    const result = AITemplates.testTemplate(template, [
      {
        author: "Billing <billing@example.com>",
        subject: "Invoice 9999 review",
        body: "Invoice 9999 amount 225 INR is ready for review.\n-- \nBilling",
      },
    ]);
    Assert.ok(result[0].matched, "the mined body-line structure should match");
  }
);

add_task(function test_empty_manual_template_never_matches_every_message() {
  const result = AITemplates.testTemplate(
    {
      id: "empty-template",
      name: "Empty template",
      enabled: true,
      match: {
        from: { mode: "contains", value: "" },
        subject: { mode: "contains", value: "" },
        body: { mode: "contains", value: "" },
        typedSlots: [],
      },
    },
    [
      {
        author: "Billing <billing@example.com>",
        subject: "Invoice 4107 review",
        body: "Invoice 4107 is ready for review.",
      },
    ]
  );
  Assert.ok(
    !result[0].matched,
    "a blank manual template must not masquerade as a template family"
  );
});
