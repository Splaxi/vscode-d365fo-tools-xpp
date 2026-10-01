/**
 * Vendored from XppSourceViewer (https://github.com/JonatanTorino/XppSourceViewer),
 * Copyright (c) 2026 Jonatan Torino, MIT License (see THIRD-PARTY-NOTICES).
 * Kept verbatim (including Spanish comments) to ease syncing upstream.
 */

/**
 * Emisión del texto X++ a partir del árbol de código.
 *
 * La sangría no se calcula: los bloques CDATA de D365FO ya vienen sangrados al
 * nivel que les corresponde (4 espacios para un método del artefacto, 8 para uno
 * de un origen de datos o un control, 12 para uno de un campo). El emisor solo
 * agrega las líneas de apertura y cierre de cada clase anidada en el nivel
 * correcto, y copia el código verbatim.
 */

import type { ContainerUnit, SourceUnit, TranspileDiagnostic } from './types';

const INDENT = '    ';

/** Atributo X++ con el que se decora cada clase anidada de un formulario. */
function attributeFor(container: ContainerUnit): string {
    switch (container.kind) {
        case 'dataSource':
            return '[DataSource]';
        case 'dataField':
            return '[DataField]';
        case 'control':
            return container.controlType
                ? `[Control('${container.controlType}')]`
                : '[Control]';
        default:
            return '[Control]';
    }
}

/**
 * Quita la llave de cierre de la declaración de clase para poder insertar el cuerpo.
 *
 * Una `<Declaration>` llega como una clase completa pero vacía:
 *
 *     public class Foo extends common
 *     {
 *     }
 *
 * Se recorta desde la última `}` hacia atrás, preservando todo lo anterior —que
 * puede incluir variables miembro—. Si no hay llave de cierre, se devuelve el
 * texto tal cual y el llamador registra un diagnóstico.
 */
function openDeclaration(declaration: string): { head: string; closed: boolean } {
    const lastBrace = declaration.lastIndexOf('}');
    if (lastBrace === -1) {
        return { head: declaration.replace(/\s+$/, ''), closed: false };
    }
    return { head: declaration.slice(0, lastBrace).replace(/\s+$/, ''), closed: true };
}

/**
 * Emite una clase anidada como un único bloque de texto.
 *
 * Devuelve el bloque entero en vez de ir agregando líneas sueltas a un arreglo
 * del llamador: ese arreglo se une con línea en blanco de por medio —para
 * separar métodos— y las líneas estructurales de la clase quedarían separadas
 * entre sí.
 */
function emitContainer(container: ContainerUnit, depth: number): { text: string; count: number } {
    const pad = INDENT.repeat(depth);
    const blocks: string[] = [];
    let count = 0;

    for (const method of container.methods) {
        blocks.push(method.source);
        count++;
    }
    for (const nested of container.containers) {
        const emitted = emitContainer(nested, depth + 1);
        blocks.push(emitted.text);
        count += emitted.count;
    }

    const lines = [pad + attributeFor(container), `${pad}class ${container.name}`, pad + '{'];
    if (blocks.length > 0) {
        lines.push(blocks.join('\n\n'));
    }
    lines.push(pad + '}');

    return { text: lines.join('\n'), count };
}

export interface EmitOutcome {
    text: string;
    methodCount: number;
    diagnostics: TranspileDiagnostic[];
}

/** Convierte el árbol de código en texto X++, con saltos de línea `\n`. */
export function emit(unit: SourceUnit): EmitOutcome {
    const diagnostics: TranspileDiagnostic[] = [];

    if (unit.unparsableSource) {
        diagnostics.push({
            severity: 'warning',
            message:
                'The artifact carries <UnparsableSource>: D365FO could not parse this source and stored it unprocessed. It is emitted as-is.'
        });
        return { text: unit.unparsableSource, methodCount: 0, diagnostics };
    }

    const header = unit.declaration ?? unit.classDeclaration?.source;
    if (!header) {
        if (unit.methods.length === 0 && unit.containers.length === 0) {
            return { text: '', methodCount: 0, diagnostics };
        }
        // Hay métodos pero no hay declaración de clase: se emiten solos antes que
        // descartarlos, y se avisa de que el resultado no compila por sí mismo.
        diagnostics.push({
            severity: 'warning',
            message:
                'The artifact has methods but declares no class (neither <Declaration> nor a classDeclaration method). The methods are emitted without a wrapper.'
        });
        const orphan: string[] = [];
        let orphanCount = 0;
        for (const method of unit.methods) {
            orphan.push(method.source);
            orphanCount++;
        }
        for (const container of unit.containers) {
            const emitted = emitContainer(container, 0);
            orphan.push(emitted.text);
            orphanCount += emitted.count;
        }
        return { text: orphan.join('\n\n'), methodCount: orphanCount, diagnostics };
    }

    const { head, closed } = openDeclaration(header);
    if (!closed) {
        diagnostics.push({
            severity: 'warning',
            message:
                'The class declaration has no closing brace. The generated X++ may be unbalanced.'
        });
    }

    const out: string[] = [head];
    const body: string[] = [];
    let methodCount = 0;

    for (const method of unit.methods) {
        body.push(method.source);
        methodCount++;
    }
    for (const container of unit.containers) {
        const emitted = emitContainer(container, 1);
        body.push(emitted.text);
        methodCount += emitted.count;
    }

    if (body.length > 0) {
        out.push('');
        out.push(body.join('\n\n'));
    }
    out.push('');
    out.push('}');

    return { text: out.join('\n'), methodCount, diagnostics };
}

/** Aplica el fin de línea pedido al texto emitido. */
export function applyEol(text: string, eol: 'crlf' | 'lf'): string {
    const normalized = text.replace(/\r\n?/g, '\n');
    return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * Quita las líneas de comentario de documentación `///`.
 *
 * Solo se descarta una línea cuando su contenido, ya sin la sangría, empieza con
 * `///`. Eso deja fuera cualquier `//` dentro de una cadena —una URL, por
 * ejemplo— salvo que ocupe la línea entera, caso que no se da en X++ real.
 *
 * Si al sacar el bloque de documentación quedan líneas en blanco al principio
 * del método, se recortan: el hueco no aporta nada.
 */
export function stripDocComments(text: string): string {
    return text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('///'))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

export interface HeaderInfo {
    kind: string;
    name: string;
    methodCount: number;
    sourceLabel?: string;
}

/** Cabecera con la procedencia del código, para no perder de vista de dónde salió. */
export function buildHeader(info: HeaderInfo): string {
    const plural = info.methodCount === 1 ? 'method' : 'methods';
    const lines = [`// ${info.kind} ${info.name} — ${info.methodCount} ${plural}`];
    if (info.sourceLabel) {
        lines.push(`// Origen: ${info.sourceLabel}`);
    }
    lines.push('');
    return lines.join('\n');
}
