# Third-party notices

This extension is MIT licensed (see [LICENSE](./LICENSE)). The custom icon
font below bundles third-party glyph outlines, which keep their own licenses.
This project is not affiliated with or endorsed by Nerd Fonts or any icon set
author.

## `resources/d365fo-icons.woff` — D365FO custom icon font (subset)

Built from `SymbolsNerdFont-Regular.ttf` (Nerd Fonts v3.5.1,
https://github.com/ryanoasis/nerd-fonts) by keeping only the 43 codepoints
listed below, converted to WOFF:

```powershell
python -m fontTools.subset symbols/SymbolsNerdFont-Regular.ttf `
  --unicodes="U+F04F1,U+F525,U+F125F,U+F059F,U+F0033,U+EC57,U+F0BC5,U+F4FC,U+F0307,U+F1312,U+F1725,U+F03E,U+F505,U+F509,U+EBEB,U+F19EF,U+F0C83,U+F0477,U+F1633,U+F13C8,U+F09A6,U+F1188,U+ED76,U+F0626,U+E21B,U+F02C1,U+F247,U+EB57,U+F0F88,U+F0835,U+F14E9,U+F160E,U+F164C,U+EC48,U+F132F,U+F11EF,U+F0C21,U+F0C03,U+F0C1E,U+F0BF4,U+F0C27,U+F0C24,U+F0BF7" `
  --flavor=woff --output-file=resources/d365fo-icons.woff `
  --name-IDs="*" --layout-features="*" --no-hinting --desubroutinize
```

The font binary is distributed under the SIL Open Font License 1.1
(copyright `Copyright (c) 2016, Ryan McIntyre`, see full text below),
bundled with this software as the OFL permits. Each glyph outline keeps its
upstream icon-set license. The font currently carries 43 glyphs:

| Icon ID | Nerd Fonts glyph | Codepoint | Upstream set | License |
|---|---|---|---|---|
| d365fo-table | nf-md-table_large | U+F04F1 | Material Design Icons (Templarian/MaterialDesign) | Apache-2.0 |
| d365fo-view | nf-oct-table | U+F525 | Octicons (primer/octicons) | MIT |
| d365fo-sysdoc | nf-md-bookshelf | U+F125F | Material Design Icons | Apache-2.0 |
| d365fo-service | nf-md-web | U+F059F | Material Design Icons | Apache-2.0 |
| d365fo-service-group | nf-md-web_plus | U+F0033 | Material Design Icons | Apache-2.0 |
| d365fo-references | nf-cod-collection | U+EC57 | Codicons (microsoft/vscode-codicons) | CC-BY-4.0 |
| d365fo-security | nf-md-shield_key_outline | U+F0BC5 | Material Design Icons | Apache-2.0 |
| d365fo-sec-role | nf-oct-passkey_fill | U+F4FC | Octicons | MIT |
| d365fo-sec-duty | nf-md-key_change | U+F0307 | Material Design Icons | Apache-2.0 |
| d365fo-sec-priv | nf-md-key_arrow_right | U+F1312 | Material Design Icons | Apache-2.0 |
| d365fo-sec-policy | nf-md-script_text_key | U+F1725 | Material Design Icons | Apache-2.0 |
| d365fo-resources | nf-fa-image | U+F03E | Font Awesome (FortAwesome/Font-Awesome) | CC-BY-4.0 |
| d365fo-reports | nf-oct-project_template | U+F505 | Octicons | MIT |
| d365fo-report-templates | nf-oct-repo_template | U+F509 | Octicons | MIT |
| d365fo-tiles | nf-cod-layout | U+EBEB | Codicons | CC-BY-4.0 |
| d365fo-menus | nf-md-folder_arrow_right_outline | U+F19EF | Material Design Icons | Apache-2.0 |
| d365fo-menu-items | nf-md-folder_text_outline | U+F0C83 | Material Design Icons | Apache-2.0 |
| d365fo-macros | nf-md-script_outline | U+F0477 | Material Design Icons | Apache-2.0 |
| d365fo-data-entity | nf-md-database_plus_outline | U+F1633 | Material Design Icons | Apache-2.0 |
| d365fo-table-collection | nf-md-table_multiple | U+F13C8 | Material Design Icons | Apache-2.0 |
| d365fo-maps | nf-md-table_merge_cells | U+F09A6 | Material Design Icons | Apache-2.0 |
| d365fo-license | nf-md-certificate_outline | U+F1188 | Material Design Icons | Apache-2.0 |
| d365fo-methods | nf-fa-boxes_stacked | U+ED76 | Font Awesome (FortAwesome/Font-Awesome) | CC-BY-4.0 |
| d365fo-method | nf-md-code_json | U+F0626 | Material Design Icons | Apache-2.0 |
| d365fo-design | nf-fae-triangle_ruler | U+E21B | Font Awesome Extension (AndreLZGava/font-awesome-extension) | MIT |
| d365fo-grid | nf-md-grid | U+F02C1 | Material Design Icons | Apache-2.0 |
| d365fo-group | nf-fa-object_group | U+F247 | Font Awesome (FortAwesome/Font-Awesome) | CC-BY-4.0 |
| d365fo-action-pane | nf-cod-split_vertical | U+EB57 | Codicons (microsoft/vscode-codicons) | CC-BY-4.0 |
| d365fo-delete-actions | nf-md-table_large_remove | U+F0F88 | Material Design Icons | Apache-2.0 |
| d365fo-fields | nf-md-table_column | U+F0835 | Material Design Icons | Apache-2.0 |
| d365fo-fulltext-indexes | nf-md-notebook_edit_outline | U+F14E9 | Material Design Icons | Apache-2.0 |
| d365fo-indexes | nf-md-family_tree | U+F160E | Material Design Icons | Apache-2.0 |
| d365fo-data-types | nf-md-database_cog_outline | U+F164C | Material Design Icons | Apache-2.0 |
| d365fo-base-enums | nf-md-folder_text_outline | U+F0C83 | Material Design Icons | Apache-2.0 |
| d365fo-extended-data-types | nf-cod-extensions_large | U+EC48 | Codicons (microsoft/vscode-codicons) | CC-BY-4.0 |
| d365fo-label-files | nf-md-alphabet_latin | U+F132F | Material Design Icons | Apache-2.0 |
| d365fo-state-machines | nf-md-state_machine | U+F11EF | Material Design Icons | Apache-2.0 |
| d365fo-field-groups | nf-md-table_multiple | U+F13C8 | Material Design Icons | Apache-2.0 |
| d365fo-type-string | nf-md-alpha_s_box_outline | U+F0C21 | Material Design Icons | Apache-2.0 |
| d365fo-type-int | nf-md-alpha_i_box_outline | U+F0C03 | Material Design Icons | Apache-2.0 |
| d365fo-type-real | nf-md-alpha_r_box_outline | U+F0C1E | Material Design Icons | Apache-2.0 |
| d365fo-type-date | nf-md-alpha_d_box_outline | U+F0BF4 | Material Design Icons | Apache-2.0 |
| d365fo-type-utcdatetime | nf-md-alpha_u_box_outline | U+F0C27 | Material Design Icons | Apache-2.0 |
| d365fo-type-time | nf-md-alpha_t_box_outline | U+F0C24 | Material Design Icons | Apache-2.0 |
| d365fo-type-enum | nf-md-alpha_e_box_outline | U+F0BF7 | Material Design Icons | Apache-2.0 |

- Material Design Icons: Apache License 2.0 (full text below),
  https://github.com/Templarian/MaterialDesign
- Octicons: MIT License (copyright GitHub, Inc.),
  https://github.com/primer/octicons
- Font Awesome Extension: MIT License,
  https://github.com/AndreLZGava/font-awesome-extension
- Nerd Fonts aggregation: MIT License (copyright (c) 2014 Ryan L McIntyre,
  full text below), https://github.com/ryanoasis/nerd-fonts
- Codicons by Microsoft (https://github.com/microsoft/vscode-codicons) and
  Font Awesome Free icons by Fonticons, Inc. (https://fontawesome.com) are
  licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/).

## MIT License (Nerd Fonts aggregation, Octicons)

```text
The MIT License (MIT)

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Octicons glyphs are additionally copyright GitHub, Inc., under the same MIT
terms — see https://github.com/primer/octicons/blob/main/LICENSE.)

## Apache License 2.0 (Material Design Icons)

```text
Apache License

Version 2.0, January 2004

http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

"Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:

You must give any other recipients of the Work or Derivative Works a copy of this License; and

You must cause any modified files to carry prominent notices stating that You changed the files; and

You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and

If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License. You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

## SIL Open Font License 1.1 (font binary)

```text
SIL OPEN FONT LICENSE

Version 1.1 - 26 February 2007

PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS

"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting -- in part or in whole -- any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION

This license becomes null and void if any of the above conditions are not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
```
