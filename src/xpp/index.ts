/**
 * Vendored from XppSourceViewer (https://github.com/JonatanTorino/XppSourceViewer),
 * Copyright (c) 2026 Jonatan Torino, MIT License (see THIRD-PARTY-NOTICES).
 * Kept verbatim (including Spanish comments) to ease syncing upstream.
 */

/**
 * API pública del transpilador de metadatos D365FO a X++.
 *
 * Punto de entrada único: `transpile(xml)`. No depende de VS Code ni del sistema
 * de archivos, así que sirve igual desde la extensión, desde un test o desde un
 * script de línea de comandos.
 */

import { DOMParser } from '@xmldom/xmldom';

import { applyEol, buildHeader, emit, stripDocComments } from './emitter';
import { buildSourceUnit, childElements, childNamed, tagOf, type DomElement } from './walker';
import {
    SOURCE_BEARING_KINDS,
    type TranspileDiagnostic,
    type TranspileOptions,
    type TranspileResult
} from './types';

export * from './types';
export { buildSourceUnit, normalizeSource, tagOf } from './walker';
export { buildHeader, stripDocComments } from './emitter';

/** Error de entrada: el texto no es un XML de metadatos de D365FO utilizable. */
export class NotMetadataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotMetadataError';
    }
}

/** ¿El nombre de elemento raíz corresponde a un tipo que puede llevar código X++? */
export function isSourceBearingKind(kind: string): boolean {
    return (SOURCE_BEARING_KINDS as readonly string[]).includes(kind);
}

/**
 * Comprobación barata, sin parsear, de si un texto parece un XML de metadatos.
 *
 * Sirve para decidir si vale la pena ofrecer la vista X++ de un archivo sin
 * pagar el costo de un parseo completo por cada `.xml` que se abra.
 */
export function looksLikeMetadata(xml: string): boolean {
    const head = xml.slice(0, 4096);
    return /<Ax[A-Z]\w*[\s>]/.test(head) && head.includes('<SourceCode');
}

/**
 * Reconstruye el código X++ de un artefacto de metadatos.
 *
 * @param xml Contenido del archivo `.xml` del artefacto.
 * @throws {NotMetadataError} si el texto no parsea o no tiene forma de artefacto.
 */
export function transpile(xml: string, options: TranspileOptions = {}): TranspileResult {
    const diagnostics: TranspileDiagnostic[] = [];

    // `@xmldom/xmldom` reporta los problemas por callback en vez de lanzar.
    const parseErrors: string[] = [];
    const parser = new DOMParser({
        onError: (level, message) => {
            if (level === 'error' || level === 'fatalError') {
                parseErrors.push(message);
            }
        }
    });

    // El BOM que escriben las herramientas de D365FO rompe el parseo si sobrevive.
    //
    // El parser reporta algunos problemas por callback y otros lanzando, así que
    // hay que contemplar las dos formas para que el llamador vea siempre el mismo
    // tipo de error.
    let root: DomElement | null;
    try {
        const document = parser.parseFromString(xml.replace(/^﻿/, ''), 'text/xml');
        root = document.documentElement as unknown as DomElement | null;
    } catch (error) {
        throw new NotMetadataError(
            `El XML no se pudo parsear: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (!root || parseErrors.length > 0) {
        throw new NotMetadataError(
            `The XML could not be parsed: ${parseErrors[0] ?? 'no root element'}`
        );
    }

    const kind = tagOf(root);
    if (!/^Ax[A-Z]/.test(kind)) {
        throw new NotMetadataError(
            `The root element is <${kind}>, which is not a D365FO metadata artifact.`
        );
    }

    const name = childNamed(root, 'Name')?.textContent?.trim() ?? '';

    // Solo el `SourceCode` que es hijo directo de la raíz. Los tipos de vista
    // llevan además un `ViewMetadata/SourceCode` con la consulta embebida, que es
    // otra unidad de compilación y no forma parte de esta clase.
    const sourceCode = childElements(root).find((c) => tagOf(c) === 'SourceCode');

    if (!sourceCode) {
        if (!isSourceBearingKind(kind)) {
            diagnostics.push({
                severity: 'info',
                message: `${kind} artifacts carry no embedded X++ source.`
            });
        } else {
            diagnostics.push({
                severity: 'info',
                message: 'El artefacto no tiene un bloque <SourceCode>.'
            });
        }
        return {
            kind,
            name,
            xpp: '',
            methodCount: 0,
            empty: true,
            unparsable: false,
            diagnostics
        };
    }

    const unit = buildSourceUnit(sourceCode);
    const outcome = emit(unit);
    diagnostics.push(...outcome.diagnostics);

    let text = outcome.text;
    if (options.stripDocComments) {
        text = stripDocComments(text);
    }
    if (options.headerComment && text.trim().length > 0) {
        text =
            buildHeader({
                kind,
                name,
                methodCount: outcome.methodCount,
                sourceLabel: options.sourceLabel
            }) + text;
    }

    const empty = outcome.text.trim().length === 0;
    if (empty) {
        diagnostics.push({
            severity: 'info',
            message:
                'The artifact declares <SourceCode> but it is empty. That is normal for staging tables and purely declarative artifacts.'
        });
    }

    return {
        kind,
        name,
        xpp: empty ? '' : applyEol(text, options.eol ?? 'crlf'),
        methodCount: outcome.methodCount,
        empty,
        unparsable: unit.unparsableSource !== undefined,
        diagnostics
    };
}
