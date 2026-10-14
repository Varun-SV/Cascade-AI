# Files, Documents and Multimodal Work

The file-delivery model depends on runtime: browser-side rendering and downloads are different from Node-side filesystem tools.

## Generated documents

| Output | Expected input | Renderer |
| --- | --- | --- |
| `.pdf` | Markdown/text content | Real selectable-text PDF |
| `.docx` | Markdown source | Real Word OOXML |
| `.pptx` | Markdown slides | Real PowerPoint presentation |
| `.xlsx` | CSV/tabular source | Real Excel workbook |

**Important:** saving Markdown into a file merely named `report.docx` does not create a Word document. In CLI/desktop workspaces, use `generate_document` or the appropriate PDF tool; in cloud web, designated `file:filename.ext` blocks are rendered for download.

Here is a hosted file block example:

    ```file:report.md
    # Findings
    - Result one
    - Result two
    ```

(The above is the file-block format models can emit for the hosted interface.) The hosted browser can offer immediate downloads without server storage; saving to the user's Files library consumes the applicable storage allowance.

## Charts and images

Document rendering can embed images and build editable chart objects in PowerPoint from compatible chart data blocks. A generated image, audio clip or video requires a configured provider supporting that modality; model routing cannot manufacture unavailable provider capabilities.

## Uploads and security

Cloud files, previews and uploads are scoped to a signed-in account. Tenant paths, file types, sizes and quotas are enforced by the server. Keep source files separate from secrets. Some operations can run client-side so data does not need to be uploaded solely for export.

Sources: [file-generation design](https://github.com/Varun-SV/Cascade-AI/blob/main/docs/file-generation.md), [document renderers](https://github.com/Varun-SV/Cascade-AI/tree/main/src/core/documents), [cloud file implementation](https://github.com/Varun-SV/Cascade-AI/blob/main/cloud/server/src/documents.ts), [media registry](https://github.com/Varun-SV/Cascade-AI/blob/main/src/core/multimodal/registry.ts).
