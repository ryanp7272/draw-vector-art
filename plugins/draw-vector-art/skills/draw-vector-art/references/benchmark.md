# Benchmark protocol

Use this protocol only when evaluating changes to the drawing workflow. Keep ordinary drawing requests on the shorter render-and-revise loop in `SKILL.md`.

## Inputs

Create a run manifest with one or more cases:

```json
{
  "version": 1,
  "name": "descriptive-run-name",
  "description": "What this run is testing",
  "protocol": {
    "directSvg": "One raw SVG response with no render feedback or revision",
    "sceneEngine": "Semantic scene with validation and up to four inspected revisions"
  },
  "cases": [
    {
      "taskId": "text-rocket",
      "directSvg": "direct/text-rocket.svg",
      "engineScene": "engine/text-rocket.scene.json"
    }
  ]
}
```

Resolve input paths relative to the run manifest. Use task IDs from `tests/evaluation/tasks.json`. Do not modify a direct-SVG result after rendering it. Record generation conditions in the run description.

## Run

```bash
npm run benchmark -- <run.json> --out <output-directory>
```

The runner rejects remote, scripted, data-URL, or `foreignObject` content; validates engine scenes; renders both methods at 64, 256, and 1024 px; and creates:

- `contact-sheet.png` for labeled review.
- `<task>/blind.png` with deterministic A/B ordering.
- `<task>/A.svg` and `<task>/B.svg` for blind editability review.
- `scorecard.csv` using the five-part 10-point rubric.
- `blind-key.json`, which reviewers should not open until scoring is complete.
- `report.json` with structural metrics and validation results.

## Interpret honestly

Treat the included three-task pilot as an illustrative smoke test, not a statistically meaningful model evaluation. Run all 12 tasks with independently generated outputs and blinded human reviewers before claiming the 9-of-12 preference target. Do not infer visual quality from file size, object count, or validator output.
