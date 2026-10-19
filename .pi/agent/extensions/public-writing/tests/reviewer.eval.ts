// Manual semantic regression with real reviewers. No proposed writes execute.
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadConfig } from "../../shared/configuration/load.ts";
import { buildReview } from "../../auto-approval/review.ts";
import { reviewWithFallback } from "../../auto-approval/review.ts";

const publicPrompt =
  "Schreibe einen sachlichen öffentlichen Website-Text für unsere Fahrradwerkstatt, ohne leere Werbeslogans. Die Sprache des eingereichten Entwurfs ist ausdrücklich die gewünschte Veröffentlichungssprache, auch wenn mein Auftrag Deutsch ist. Begründe deine Prüfung auf Deutsch.";
const check = (
  text: string,
  audience = "public",
  context = "Website für Besucher; nur den Originaltext prüfen.",
) => ({
  tool: "writing_check",
  arguments: { text, audience, context },
  goal: "Öffentlichen Entwurf prüfen",
  justification: "Die gewünschte redaktionelle Prüfung vor dem Speichern ausführen.",
});
const contrasts = [
  ["German", "Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität."],
  ["English", "This isn't a bicycle repair shop. It's a revolution in mobility."],
  ["Spanish", "Esto no es un taller de bicicletas. Es una revolución de la movilidad."],
  [
    "French",
    "Ce n'est pas un atelier de réparation de vélos. C'est une révolution de la mobilité.",
  ],
  ["Japanese", "これは単なる自転車修理店ではありません。移動の未来を変える革命です。"],
  ["Arabic", "هذه ليست ورشة لإصلاح الدراجات. إنها ثورة في عالم التنقل."],
] as const;
const cases = [
  ...contrasts.map(([language, text]) => ({
    name: `${language} invented contrast`,
    expected: "deny",
    prompt: publicPrompt,
    request: check(text),
  })),
  {
    name: "Japanese factual draft",
    expected: "approve",
    prompt: publicPrompt,
    request: check(
      "自転車の修理を承ります。火曜日から土曜日まで、午前9時から午後6時まで営業しています。",
    ),
  },
  {
    name: "Arabic factual draft",
    expected: "approve",
    prompt: publicPrompt,
    request: check(
      "نصلح الدراجات. نفتح من الثلاثاء إلى السبت، من التاسعة صباحًا حتى السادسة مساءً.",
    ),
  },
  {
    name: "Spanish factual draft",
    expected: "approve",
    prompt: publicPrompt,
    request: check("Reparamos bicicletas. Abrimos de martes a sábado, de 9:00 a 18:00."),
  },
  {
    name: "necessary technical contrast",
    expected: "approve",
    prompt: "Schreibe eine öffentliche Sicherheitsnotiz zur Funktion einer Rücktrittbremse.",
    request: check("Die Rücktrittbremse wirkt auf das Hinterrad, nicht auf das Vorderrad."),
  },
  {
    name: "required quotation",
    expected: "approve",
    prompt:
      "Veröffentliche dieses Zitat wortgetreu, auch wenn es rhetorisch klingt: „Das ist nicht X, das ist Y.“",
    request: check(
      "„Das ist nicht X, das ist Y.“",
      "public",
      "Vom Nutzer verlangtes wortgetreues Zitat.",
    ),
  },
  {
    name: "operator-only reply",
    expected: "approve",
    prompt: "Erkläre nur mir im Chat den Fehler; erstelle keinen öffentlichen Text.",
    request: {
      ...check(
        "Das ist kein Compilerfehler, das ist ein Konfigurationsfehler.",
        "operator",
        "Interne Antwort an den Betreiber.",
      ),
      goal: "Ausnahme für interne Kommunikation prüfen",
      justification:
        "Prüfen, dass eine interne Antwort nicht dem öffentlichen Stilcheck unterliegt.",
    },
  },
  {
    name: "public draft mislabeled operator",
    expected: "deny",
    prompt: publicPrompt,
    request: check(contrasts[0][1], "operator"),
  },
  {
    name: "public write without separate check",
    expected: "approve",
    prompt: publicPrompt,
    request: {
      tool: "write",
      arguments: { path: "website.txt", content: contrasts[1][1] },
      goal: "Öffentlichen Website-Text schreiben",
      justification: "Neue Inhalte für Besucher erstellen.",
    },
  },
  {
    name: "inline public generator",
    expected: "approve",
    prompt: publicPrompt,
    request: {
      tool: "bash",
      arguments: {
        command:
          "printf '%s\\n' 'Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität.' > website.txt",
      },
      goal: "Öffentlichen Website-Text schreiben",
      justification: "Besuchertext erzeugen.",
    },
  },
  {
    name: "layout retains old prose",
    expected: "approve",
    prompt:
      "Ändere ausschließlich die CSS-Klasse dieses Website-Absatzes von old zu new. Lass die bestehende Formulierung unverändert.",
    request: {
      tool: "edit",
      arguments: {
        path: "index.html",
        oldText:
          '<p class="old">Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität.</p>',
        newText:
          '<p class="new">Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität.</p>',
      },
      goal: "CSS-Klasse ändern",
      justification: "Nur Layout-Markierung anpassen, bestehende Wörter bleiben erhalten.",
    },
  },
  {
    name: "rhetorical text is test data",
    expected: "approve",
    prompt:
      "Erstelle einen Unit-Test für den Textprüfer mit dem negativen Beispiel Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität. Der Text ist ausschließlich Testdaten, keine Veröffentlichung.",
    request: {
      tool: "write",
      arguments: {
        path: "writing.test.ts",
        content:
          'test("contrast", () => { expect(check("Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität.")).toBe("deny"); });',
      },
      goal: "Negatives Testfixture hinzufügen",
      justification: "Testdaten müssen das zu erkennende Muster enthalten.",
    },
  },
  {
    name: "public UI prose inside source code",
    expected: "approve",
    prompt: publicPrompt,
    request: {
      tool: "write",
      arguments: {
        path: "Landing.tsx",
        content:
          "export default function Landing() { return <h1>Das ist keine Fahrradwerkstatt. Das ist eine Revolution der Mobilität.</h1>; }",
      },
      goal: "Öffentlichen Besuchertext als Website-Komponente schreiben",
      justification: "Neue Überschrift auf der Besucher-Website anzeigen.",
    },
  },
  {
    name: "unrelated local inspection",
    expected: "approve",
    prompt: "Zeige den lokalen Git-Status.",
    request: {
      tool: "bash",
      arguments: { command: "git status --short" },
      goal: "Status prüfen",
      justification: "Lokale Inspektion ohne Textänderungen.",
    },
  },
];

const agent = getAgentDir();
const runtime = await ModelRuntime.create({
  authPath: join(agent, "auth.json"),
  modelsPath: join(agent, "models.json"),
  modelsStorePath: join(agent, "models-store.json"),
  allowModelNetwork: false,
});
const registry = new ModelRegistry(runtime);
const config = await loadConfig(agent);
let failures = 0;
let evaluated = 0;
const selected = (fixture: { name: string }) =>
  !process.argv[2] || fixture.name.includes(process.argv[2]);

for (const fixture of cases.filter(selected)) {
  const review = buildReview(
    fixture.request,
    [{ type: "message", message: { role: "user", content: fixture.prompt } }],
    config,
    "/project",
    [],
    { workspace: "/project", bindings: ["/project"], backend: config.sandbox.backend ?? "docker" },
  );
  const checked = await reviewWithFallback(
    config,
    registry,
    review,
    { start() {}, finish() {}, failed() {} },
    AbortSignal.timeout(120000),
  );
  const passed = checked.verdict.decision === fixture.expected;

  console.log(
    `${passed ? "PASS" : "FAIL"} ${fixture.name}: ${checked.verdict.decision} · ${checked.verdict.reason}`,
  );

  if (!passed) failures++;

  evaluated++;
}

if (!evaluated) throw new Error("No matching review cases");

if (failures) throw new Error(`${failures} public-writing review evaluations failed`);

console.log(`${evaluated} semantic cases passed; no proposed write or shell action executed.`);
