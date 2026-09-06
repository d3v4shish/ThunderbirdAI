# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import os
import shutil
import urllib.error
import urllib.request
from pathlib import Path

from marionette_driver import Wait
from marionette_harness import MarionetteTestCase

SOURCE_ID = "source-local-ollama-smoke"
SOURCE_URL = "http://127.0.0.1:11434/v1/chat/completions"
SOURCE_MODEL = "llama3.2"
FOLDER_NAME = "AIRealEndpointSmoke"
MAIL_MARKER = "ORBIT-CEDAR-7319"


class TestAIRealEndpointSmoke(MarionetteTestCase):
    """Exercise a real Ollama endpoint and persistent disposable profile."""

    def setUp(self):
        MarionetteTestCase.setUp(self)
        if os.environ.get("TB_AI_REAL_ENDPOINT_SMOKE") != "1":
            self.skipTest("Set TB_AI_REAL_ENDPOINT_SMOKE=1 for the Ollama smoke test")
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.marionette.timeout.script = 180

    def run_async(self, script, script_args=None):
        wrapped = f"""
            let args = Array.from(arguments);
            let resolve = args.pop();
            (async () => {{
                try {{
                    resolve(["ok", await (async (...scriptArgs) => {{ {script} }})(...args)]);
                }} catch (error) {{
                    resolve(["error", error?.message || String(error), error?.stack || ""]);
                }}
            }})();
        """
        result = self.marionette.execute_async_script(
            wrapped,
            script_args=script_args or [],
            new_sandbox=False,
        )
        if result[0] != "ok":
            raise AssertionError(f"Async chrome script failed: {result[1]}\n{result[2]}")
        return result[1]

    def rpc(self, endpoint, token, method, params=None, request_id=1):
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def seed_and_run(self, run_workflows=True):
        return self.run_async(
            """
            const runWorkflows = scriptArgs[0] !== false;
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const { AIService } = ChromeUtils.importESModule(
              "moz-src:///comm/mail/components/ai/modules/AIService.sys.mjs"
            );
            const { AIStorage } = ChromeUtils.importESModule(
              "moz-src:///comm/mail/components/ai/modules/AIStorage.sys.mjs"
            );
            const { AISources } = ChromeUtils.importESModule(
              "resource:///modules/AISources.sys.mjs"
            );
            const { AIMCPServer } = ChromeUtils.importESModule(
              "moz-src:///comm/mail/components/ai/modules/AIMCPServer.sys.mjs"
            );

            Services.prefs.setBoolPref("mail.ai.enabled", true);
            Services.prefs.setBoolPref("mail.ai.backfill.enabled", false);
            Services.prefs.setStringPref("mail.ai.trace.mode", "metadata-only");
            Services.prefs.setBoolPref("mail.ai.mcp.enabled", true);
            Services.prefs.setIntPref("mail.ai.mcp.port", 0);
            await AIService.init();
            await AISources.init();

            let localServer;
            try {
              localServer = MailServices.accounts.localFoldersServer;
            } catch {
              MailServices.accounts.createLocalMailAccount();
              localServer = MailServices.accounts.localFoldersServer;
            }
            const root = localServer.rootFolder.QueryInterface(
              Ci.nsIMsgLocalMailFolder
            );
            let folder = root.getChildNamed("AIRealEndpointSmoke");
            if (!folder) {
              folder = root.createLocalSubfolder("AIRealEndpointSmoke");
            }
            let msgHdr = [...folder.messages].find(
              header => header.messageId == "ai-real-endpoint-smoke@example.invalid"
            );
            if (!msgHdr) {
              folder.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage([
                "From: Smoke Fixture <smoke@example.invalid>",
                "To: Thunderbird AI <recipient@example.invalid>",
                "Subject: Endpoint smoke launch code",
                "Message-ID: <ai-real-endpoint-smoke@example.invalid>",
                "Date: Tue, 19 Aug 2026 10:00:00 +0530",
                "MIME-Version: 1.0",
                "Content-Type: text/plain; charset=UTF-8",
                "",
                "The endpoint smoke launch code is ORBIT-CEDAR-7319.",
                "",
              ].join("\\r\\n"));
              msgHdr = [...folder.messages].find(
                header => header.messageId == "ai-real-endpoint-smoke@example.invalid"
              );
            }
            const messageId = `${folder.URI}#${msgHdr.messageKey}`;
            AIStorage.setMessage(messageId, {
              accountKey: localServer.key,
              folderURI: folder.URI,
              messageKey: msgHdr.messageKey,
              subject: msgHdr.mime2DecodedSubject,
              author: msgHdr.mime2DecodedAuthor,
              summary: "The endpoint smoke launch code is ORBIT-CEDAR-7319.",
              category: "operations",
              localText: "The endpoint smoke launch code is ORBIT-CEDAR-7319.",
              embedding: [1, 0, 0],
              securityAssessment: {
                verdict: "safe",
                score: 0,
                evidenceIds: [],
                summary: "No suspicious evidence in the local smoke fixture.",
                recommendedActions: [],
              },
            });

            const source = await AISources.upsertSource({
              id: "source-local-ollama-smoke",
              name: "Local Ollama smoke",
              type: "ollama",
              endpointURL: "http://127.0.0.1:11434/v1/chat/completions",
              model: "llama3.2",
              organization: "",
              project: "",
              background: true,
              allowCloud: false,
            });
            Services.prefs.setStringPref("mail.ai.provider", "source");
            Services.prefs.setStringPref("mail.ai.source_id", source.id);
            Services.prefs.setStringPref(
              "mail.ai.assistant_fallback.source_id",
              source.id
            );

            const endpointHealth =
              await AIService.probeAssistantFallbackHealth("global");
            const endpointTest = await AIService.testEndpointDetailed("global", {
              sourceId: source.id,
              role: "assistant",
            });
            const answer = await AIService.askAssistant({
              prompt: "What is the endpoint smoke launch code? Answer with the code.",
              accountKey: localServer.key,
              folderURI: folder.URI,
              messageIds: [messageId],
              scopeMode: "selected",
              directRag: false,
              reranking: true,
            });

            const cancelledController = new AbortController();
            cancelledController.abort();
            const cancelled = await AIService.askAssistant({
              prompt: "Repeat the endpoint smoke launch code.",
              accountKey: localServer.key,
              folderURI: folder.URI,
              messageIds: [messageId],
              scopeMode: "selected",
              signal: cancelledController.signal,
            });
            const retry = await AIService.askAssistant({
              prompt: "Retry: what is the endpoint smoke launch code?",
              accountKey: localServer.key,
              folderURI: folder.URI,
              messageIds: [messageId],
              scopeMode: "selected",
            });

            let workflows = null;
            if (runWorkflows) {
              Services.prefs.setBoolPref("mail.ai.workflows.enabled", true);
              AIStorage.setMessage(messageId, {
                ...AIStorage.getMessage(messageId),
                category: "support",
                trustedCategory: "support",
                priority: "high",
                status: "needs-reply",
                needsReply: true,
                body: [
                  "BUG: endpoint smoke launch service failed after an NVMe timeout.",
                  "Stack trace marker ORBIT-CEDAR-7319.",
                ].join("\\n"),
                actionItems: ["Explain the failure", "Prepare a follow-up"],
                riskFlags: ["production incident"],
              });
              const workflowId = (workflow, targetId = messageId) =>
                ["triage-workflow", workflow, targetId]
                  .map(part => encodeURIComponent(part))
                  .join("|");
              const workflowTypes = [
                "executive-summary",
                "translation",
                "technical-explanation",
                "jira-task",
                "support-response",
              ];
              const prepared = {};
              for (const workflow of workflowTypes) {
                prepared[workflow] = await AIService.applyTriageAction(
                  workflowId(workflow)
                );
              }
              const calendarId = `${folder.URI}#999999`;
              AIStorage.setMessage(calendarId, {
                accountKey: localServer.key,
                folderURI: folder.URI,
                messageKey: 999999,
                subject: "Smoke review Tuesday 3 PM",
                summary: "Review the endpoint smoke result Tuesday at 3 PM.",
                category: "calendar",
                actionItems: ["Review endpoint result"],
                extractedEntities: { dates: ["Tuesday 3 PM"] },
              });
              const calendar = await AIService.applyTriageAction(
                workflowId("calendar-event", calendarId)
              );
              const task = await AIService.applyTriageAction(
                workflowId("task", calendarId)
              );
              AIStorage.removeMessage(calendarId);

              const draft = await AIService.applyTriageAction(
                ["triage-draft", messageId]
                  .map(part => encodeURIComponent(part))
                  .join("|")
              );
              const organization = await AIService.getAutomationSuggestions();
              workflows = {
                prepared,
                calendar,
                task,
                draft,
                organization,
                sourceMessagePresent: !!AIStorage.getMessage(messageId),
              };
            }

            const traces = AIStorage.getRecentTraces(20);
            const diagnostic = await AIService.exportDiagnosticBundle();
            await AIMCPServer.init();
            await AIMCPServer.updateFromPrefs();
            const mcp = AIMCPServer.getHTTPClientConfig();
            AIService.setCurrentSelection({
              accountKey: localServer.key,
              folderURI: folder.URI,
              messageIds: [messageId],
            });
            if (runWorkflows) {
              // Leave representative helper-era preferences for the same
              // profile's restart to migrate. The configured endpoint and
              // mailbox record must survive that normalization.
              Services.prefs.setStringPref("mail.ai.assistant.mode", "gpu-local");
              Services.prefs.setStringPref(
                "mail.ai.assistant.cpu_model_id",
                "legacy-smoke-assistant"
              );
              Services.prefs.setStringPref("mail.ai.summaries.mode", "helper-local");
              Services.prefs.setStringPref("mail.ai.embeddings.mode", "onnx-local");
              Services.prefs.setBoolPref(
                "mail.ai.helper.debug_bridge.enabled",
                true
              );
            }
            return {
              profilePath: PathUtils.profileDir,
              source,
              messageId,
              accountKey: localServer.key,
              folderURI: folder.URI,
              endpointHealth,
              endpointTest,
              answer,
              cancelled,
              retry,
              workflows,
              traces,
              diagnosticPath: diagnostic.exportPath,
              diagnosticRedacted: diagnostic.redacted,
              mcp: {
                endpoint: mcp.endpoint,
                token: String(mcp.headers.Authorization).replace(/^Bearer /, ""),
              },
              migration: {
                assistantMode: Services.prefs.getStringPref(
                  "mail.ai.assistant.mode",
                  ""
                ),
                summariesMode: Services.prefs.getStringPref(
                  "mail.ai.summaries.mode",
                  ""
                ),
                embeddingsMode: Services.prefs.getStringPref(
                  "mail.ai.embeddings.mode",
                  ""
                ),
                retiredPrefsPresent: [
                  "mail.ai.assistant.cpu_model_id",
                  "mail.ai.helper.debug_bridge.enabled",
                ].filter(pref => Services.prefs.prefHasUserValue(pref)),
              },
            };
            """,
            [run_workflows],
        )

    def assert_smoke_result(self, result):
        self.assertEqual(result["source"]["id"], SOURCE_ID)
        self.assertEqual(result["source"]["endpointURL"], SOURCE_URL)
        self.assertEqual(result["source"]["model"], SOURCE_MODEL)
        self.assertEqual(result["endpointHealth"]["reachabilityState"], "reachable")
        self.assertIn(result["endpointHealth"]["state"], ("reachable", "available"))
        self.assertGreaterEqual(result["endpointHealth"]["lastProbeLatencyMs"], 0)
        self.assertTrue(result["endpointTest"]["answer"])
        self.assertTrue(result["answer"]["usedEndpoint"])
        self.assertIn(MAIL_MARKER, result["answer"]["answer"])
        self.assertTrue(
            any(
                citation.get("messageId") == result["messageId"]
                for citation in result["answer"]["citations"]
            )
        )
        self.assertEqual(result["cancelled"]["status"], "cancelled")
        self.assertTrue(result["retry"]["usedEndpoint"])
        self.assertIn(MAIL_MARKER, result["retry"]["answer"])
        if result["workflows"]:
            workflows = result["workflows"]
            for workflow in (
                "executive-summary",
                "translation",
                "technical-explanation",
                "jira-task",
                "support-response",
            ):
                self.assertTrue(workflows["prepared"][workflow]["resultText"])
            self.assertEqual(
                workflows["calendar"]["clientAction"]["type"],
                "calendar-extract",
            )
            self.assertTrue(workflows["calendar"]["clientAction"]["isEvent"])
            self.assertFalse(workflows["task"]["clientAction"]["isEvent"])
            self.assertTrue(workflows["draft"]["draftText"])
            self.assertTrue(workflows["sourceMessagePresent"])
            self.assertTrue(workflows["organization"])
            self.assertTrue(
                all(suggestion["requiresConfirmation"] for suggestion in workflows["organization"])
            )
        self.assertTrue(result["diagnosticRedacted"])
        diagnostic_path = Path(result["diagnosticPath"])
        self.assertTrue(diagnostic_path.is_file())
        diagnostic_text = diagnostic_path.read_text(encoding="utf-8")
        self.assertNotIn(
            "The endpoint smoke launch code is ORBIT-CEDAR-7319.",
            diagnostic_text,
            "Redacted diagnostics must not retain mailbox evidence or prompts",
        )
        diagnostic = json.loads(diagnostic_text)
        self.assertTrue(diagnostic["assistantActivity"]["usedEndpoint"])
        self.assertGreaterEqual(diagnostic["assistantActivity"]["citationCount"], 1)

        serialized_traces = json.dumps(result["traces"])
        self.assertNotIn(
            "The endpoint smoke launch code is ORBIT-CEDAR-7319.",
            serialized_traces,
            "Metadata-only traces must not retain the unredacted message body",
        )

    def run_release_profile_checks(self, result):
        return self.run_async(
            """
            const [folderURI, messageId] = scriptArgs;
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const { AIService } = ChromeUtils.importESModule(
              "moz-src:///comm/mail/components/ai/modules/AIService.sys.mjs"
            );
            const { AIStorage } = ChromeUtils.importESModule(
              "moz-src:///comm/mail/components/ai/modules/AIStorage.sys.mjs"
            );
            const { AISources } = ChromeUtils.importESModule(
              "resource:///modules/AISources.sys.mjs"
            );
            const { MailSecurity } = ChromeUtils.importESModule(
              "resource:///modules/MailSecurity.sys.mjs"
            );
            const { AttachmentClamAV } = ChromeUtils.importESModule(
              "resource:///modules/AttachmentClamAV.sys.mjs"
            );
            const { AttachmentScanCache } = ChromeUtils.importESModule(
              "resource:///modules/AttachmentScanCache.sys.mjs"
            );
            const { AttachmentScanScheduler } = ChromeUtils.importESModule(
              "resource:///modules/AttachmentScanScheduler.sys.mjs"
            );

            const folder = MailServices.folderLookup
              .getFolderForURL(folderURI)
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            const sourceHeader = [...folder.messages].find(
              header =>
                `${folder.URI}#${header.messageKey}` == messageId
            );
            if (!sourceHeader) {
              throw new Error("The source message disappeared before release checks.");
            }

            const semanticResults = AIStorage.semanticSearch(
              "ORBIT CEDAR 7319",
              sourceHeader.folder.server.key,
              5,
              { folderURI }
            );
            const security = await AIService.getSecurityCenterData(sourceHeader, {
              forceSecurityRefresh: true,
            });
            const dlpPref = "mail.security.compose.dlp.enabled";
            const hadDLPUserValue = Services.prefs.prefHasUserValue(dlpPref);
            const originalDLPEnabled = Services.prefs.getBoolPref(dlpPref, false);
            Services.prefs.setBoolPref(dlpPref, true);
            const dlpSignals = MailSecurity.analyzeDLP({
              subject: "Release smoke",
              body: "The password is correct-horse-battery-staple and must not leak.",
            });
            if (hadDLPUserValue) {
              Services.prefs.setBoolPref(dlpPref, originalDLPEnabled);
            } else {
              Services.prefs.clearUserPref(dlpPref);
            }

            const databasePath = PathUtils.join(
              PathUtils.profileDir,
              "ai-smoke-clamav-db"
            );
            await IOUtils.makeDirectory(databasePath, {
              createAncestors: true,
              ignoreExisting: true,
            });
            await IOUtils.writeUTF8(
              PathUtils.join(databasePath, "smoke.hdb"),
              "44d88612fea8a8f36de82e1278abb02f:68:Eicar-Test-Signature\\n"
            );
            const cleanPath = PathUtils.join(databasePath, "clean.txt");
            const infectedPath = PathUtils.join(databasePath, "eicar.txt");
            const eicar =
              "X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
            await IOUtils.writeUTF8(cleanPath, "Clean attachment smoke fixture.");
            await IOUtils.writeUTF8(infectedPath, eicar);
            Services.prefs.setStringPref(
              "mail.attachments.security.clamav.database_path",
              databasePath
            );
            Services.prefs.setBoolPref(
              "mail.attachments.security.native.enabled",
              true
            );
            AttachmentClamAV.terminate();
            AttachmentClamAV._helperPathSearchResult = null;
            AttachmentClamAV._databaseStatusCache = null;
            const cleanScan = await AttachmentClamAV.scanFile(cleanPath);
            const infectedScan = await AttachmentClamAV.scanFile(infectedPath);

            let attachmentHeader = [...folder.messages].find(
              header => header.messageId == "ai-real-endpoint-av@example.invalid"
            );
            if (!attachmentHeader) {
              folder.addMessage([
                "From: AV Smoke <av@example.invalid>",
                "To: Thunderbird AI <recipient@example.invalid>",
                "Subject: Native attachment scan smoke",
                "Message-ID: <ai-real-endpoint-av@example.invalid>",
                "Date: Tue, 19 Aug 2026 10:01:00 +0530",
                "MIME-Version: 1.0",
                "Content-Type: multipart/mixed; boundary=smoke-boundary",
                "",
                "--smoke-boundary",
                "Content-Type: text/plain; charset=UTF-8",
                "",
                "Native attachment scan fixture.",
                "--smoke-boundary",
                "Content-Type: application/octet-stream; name=eicar.txt",
                "Content-Disposition: attachment; filename=eicar.txt",
                "Content-Transfer-Encoding: base64",
                "",
                btoa(eicar),
                "--smoke-boundary--",
                "",
              ].join("\\r\\n"));
              attachmentHeader = [...folder.messages].find(
                header => header.messageId == "ai-real-endpoint-av@example.invalid"
              );
            }
            AttachmentScanScheduler._currentItem = {
              id: `${folder.URI}#${attachmentHeader.messageKey}`,
              attachmentName: "",
            };
            let schedulerScan;
            try {
              schedulerScan = await AttachmentScanScheduler._scanMessage(
                attachmentHeader,
                true
              );
            } finally {
              AttachmentScanScheduler._currentItem = null;
            }
            const cachedAttachmentScan = AttachmentScanCache.getState(
              attachmentHeader
            );

            const endpointBeforeReset = AISources.getSource(
              "source-local-ollama-smoke"
            );
            const messagesBeforeReset = [...folder.messages].length;
            const reset = await AIService.resetDataGovernanceScope("analysis");
            const endpointAfterReset = AISources.getSource(
              "source-local-ollama-smoke"
            );
            const sourceAfterReset = [...folder.messages].find(
              header => header.messageId == "ai-real-endpoint-smoke@example.invalid"
            );

            AttachmentClamAV.terminate();
            return {
              semanticSearch: {
                foundSource: semanticResults.some(item => item.messageId == messageId),
                resultCount: semanticResults.length,
              },
              security: {
                rendered: !!security,
                verdict: security?.technicalVerdict?.verdict || "",
                authStatus: security?.technicalVerdict?.authStatus || "",
                timelineCount: security?.securityTimeline?.length || 0,
              },
              dlp: {
                detected: dlpSignals.length > 0,
                signalIds: dlpSignals.map(signal => signal.id),
              },
              attachmentScanning: {
                cleanVerdict: cleanScan.verdict,
                infectedVerdict: infectedScan.verdict,
                schedulerVerdict: schedulerScan.summary,
                cachedVerdict: cachedAttachmentScan.summary,
              },
              reset: {
                scopeId: reset.scopeId,
                analysisRemoved: AIStorage.getMessage(messageId) === null,
                sourceMessagePresent: !!sourceAfterReset,
                mailboxMessageCountPreserved:
                  [...folder.messages].length == messagesBeforeReset,
                endpointPreserved:
                  endpointBeforeReset?.id == endpointAfterReset?.id,
              },
            };
            """,
            [result["folderURI"], result["messageId"]],
        )

    def assert_mcp(self, result):
        endpoint = result["mcp"]["endpoint"]
        token = result["mcp"]["token"]
        self.assertTrue(endpoint.startswith("http://127.0.0.1:"))
        with self.assertRaises(urllib.error.HTTPError) as unauthorized:
            self.rpc(endpoint, "wrong-token", "tools/list")
        self.assertEqual(unauthorized.exception.code, 401)

        tools = self.rpc(endpoint, token, "tools/list")["result"]["tools"]
        tool_names = {tool["name"] for tool in tools}
        self.assertIn("thunderbird.search_mailbox", tool_names)
        self.assertIn("thunderbird.get_message_text", tool_names)
        self.assertIn("thunderbird.get_current_selection", tool_names)
        self.assertIn("thunderbird.get_message_summary", tool_names)
        self.assertIn("thunderbird.get_debug_traces", tool_names)
        self.assertFalse(any("send" in name or "delete" in name for name in tool_names))

        resources = self.rpc(endpoint, token, "resources/list")["result"]["resources"]
        resource_uris = {resource["uri"] for resource in resources}
        self.assertIn("thunderbird://ai/status", resource_uris)
        self.assertIn("thunderbird://ai/current-selection", resource_uris)

        search_rpc = self.rpc(
            endpoint,
            token,
            "tools/call",
            {
                "name": "thunderbird.search_mailbox",
                "arguments": {"query": MAIL_MARKER, "limit": 5},
            },
        )
        search_result = json.loads(search_rpc["result"]["content"][0]["text"])
        self.assertEqual(search_result["status"], "ok")
        self.assertTrue(
            any(item["messageId"] == result["messageId"] for item in search_result["results"])
        )

        message_rpc = self.rpc(
            endpoint,
            token,
            "tools/call",
            {
                "name": "thunderbird.get_message_text",
                "arguments": {"messageId": result["messageId"], "maxChars": 1000},
            },
        )
        message_result = json.loads(message_rpc["result"]["content"][0]["text"])
        self.assertTrue(message_result["untrustedContent"])
        self.assertIn("untrusted", message_result["safety"].lower())
        self.assertIn(MAIL_MARKER, message_result["body"])

    def test_real_endpoint_persists_across_restart(self):
        first = self.seed_and_run(run_workflows=True)
        self.assert_smoke_result(first)
        self.assert_mcp(first)

        self.marionette.quit(in_app=True)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.marionette.timeout.script = 180
        Wait(self.marionette, timeout=30).until(lambda mn: len(mn.chrome_window_handles) >= 1)

        second = self.seed_and_run(run_workflows=False)
        self.assert_smoke_result(second)
        self.assert_mcp(second)
        self.assertEqual(first["profilePath"], second["profilePath"])
        self.assertEqual(second["migration"]["assistantMode"], "endpoint")
        self.assertEqual(second["migration"]["summariesMode"], "endpoint-first")
        self.assertEqual(second["migration"]["embeddingsMode"], "endpoint-first")
        self.assertEqual(second["migration"]["retiredPrefsPresent"], [])

        release_checks = self.run_release_profile_checks(second)
        self.assertTrue(release_checks["semanticSearch"]["foundSource"])
        self.assertTrue(release_checks["security"]["rendered"])
        self.assertGreater(release_checks["security"]["timelineCount"], 0)
        self.assertTrue(release_checks["dlp"]["detected"])
        self.assertEqual(release_checks["attachmentScanning"]["cleanVerdict"], "clean")
        self.assertEqual(release_checks["attachmentScanning"]["infectedVerdict"], "infected")
        self.assertEqual(release_checks["attachmentScanning"]["schedulerVerdict"], "infected")
        self.assertEqual(release_checks["attachmentScanning"]["cachedVerdict"], "infected")
        self.assertEqual(release_checks["reset"]["scopeId"], "analysis")
        self.assertTrue(release_checks["reset"]["analysisRemoved"])
        self.assertTrue(release_checks["reset"]["sourceMessagePresent"])
        self.assertTrue(release_checks["reset"]["mailboxMessageCountPreserved"])
        self.assertTrue(release_checks["reset"]["endpointPreserved"])

        report = {
            "schemaVersion": 1,
            "profileKind": "disposable-local-mail",
            "source": {
                "id": second["source"]["id"],
                "type": second["source"]["type"],
                "model": second["source"]["model"],
                "loopback": second["source"]["endpointURL"].startswith("http://127.0.0.1:"),
            },
            "assistant": {
                "endpointTestPassed": bool(second["endpointTest"]["answer"]),
                "citedAnswerPassed": any(
                    citation.get("messageId") == second["messageId"]
                    for citation in second["answer"]["citations"]
                ),
                "cancelPassed": second["cancelled"]["status"] == "cancelled",
                "retryPassed": bool(second["retry"]["usedEndpoint"]),
            },
            "migration": second["migration"],
            "releaseChecks": release_checks,
            "diagnosticRedacted": bool(second["diagnosticRedacted"]),
        }
        report_path = os.environ.get("TB_AI_SMOKE_REPORT", "")
        if report_path:
            destination_report = Path(report_path).resolve()
            destination_report.parent.mkdir(parents=True, exist_ok=True)
            destination_report.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

        export_path = os.environ.get("TB_AI_SMOKE_PROFILE_EXPORT", "")
        if export_path:
            source_profile = Path(second["profilePath"])
            destination = Path(export_path).resolve()
            self.marionette.quit(in_app=True)
            if destination.exists() and any(destination.iterdir()):
                sources_path = destination / "ai" / "sources.json"
                if not sources_path.is_file() or SOURCE_ID not in sources_path.read_text(
                    encoding="utf-8"
                ):
                    raise AssertionError(f"Refusing to overwrite non-smoke profile: {destination}")
            destination.mkdir(parents=True, exist_ok=True)
            for lock_name in ("lock", ".parentlock", "parent.lock"):
                lock_path = destination / lock_name
                if lock_path.exists() or lock_path.is_symlink():
                    lock_path.unlink()
            shutil.copytree(
                source_profile,
                destination,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("lock", ".parentlock", "parent.lock"),
            )
