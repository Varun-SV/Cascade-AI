import { describe, expect, it } from 'vitest';
import { planSpecShape, quotedFieldRules, typedFieldRules } from './plan-spec.js';

describe('planSpecShape', () => {
  it('keeps the file-and-shell shape when the run can write files', () => {
    const spec = planSpecShape(true);
    expect(spec.exampleFiles).toBe('["package.json"]');
    expect(spec.acceptanceGuidance).toContain('file exists');
    expect(spec.preamble).toBe('');
  });

  it('never shows a file-shaped example to a run that cannot write files', () => {
    // The production failure started here: T1's worked example ran `npm init`
    // and asserted "package.json exists and parses as JSON", on a hosted run
    // whose entire tool set is web_search/web_fetch. A worked example beats a
    // system-prompt sentence, so the planner produced "Create Project
    // Directory Structure" and every worker under it was doomed.
    const spec = planSpecShape(false);
    expect(spec.exampleFiles).toBe('[]');
    expect(spec.exampleAcceptance).not.toMatch(/exists|\.json|\.md/);
    expect(spec.exampleDescription).not.toMatch(/npm|install|run |create .*file/i);
    expect(spec.exampleContextBrief).not.toMatch(/npm available/i);
  });

  it('tells the planner outright that nothing can touch the disk', () => {
    const spec = planSpecShape(false);
    expect(spec.preamble).toMatch(/no file, shell, or code-execution tools/i);
    expect(spec.preamble).toMatch(/written answer IS the deliverable/i);
  });

  it('forbids the criterion shape that cannot be satisfied', () => {
    const spec = planSpecShape(false);
    expect(spec.acceptanceGuidance).toMatch(/READING THE WRITTEN ANSWER/);
    expect(spec.acceptanceGuidance).toMatch(/NEVER phrase one as a file existing/i);
    expect(spec.filesGuidance).toMatch(/leave EMPTY/i);
  });

  it('renders one piece of guidance behind each tier’s own label', () => {
    // T1 and T2 label the same fields differently. The guidance is stored once
    // precisely so the two prompts cannot drift again — assert both renderings
    // carry the identical sentence.
    const spec = planSpecShape(false);
    expect(quotedFieldRules(spec)).toContain(`- "files": ${spec.filesGuidance}`);
    expect(quotedFieldRules(spec)).toContain(`- "acceptance": ${spec.acceptanceGuidance}`);
    expect(typedFieldRules(spec)).toContain(`- files: string[] — ${spec.filesGuidance}`);
    expect(typedFieldRules(spec)).toContain(`- acceptance: string[] — ${spec.acceptanceGuidance}`);
  });
});
