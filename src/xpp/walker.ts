/**
 * Vendored from XppSourceViewer (https://github.com/JonatanTorino/XppSourceViewer),
 * Copyright (c) 2026 Jonatan Torino, MIT License (see THIRD-PARTY-NOTICES).
 * Kept verbatim (including Spanish comments) to ease syncing upstream.
 */

/**
 * Recorrido del XML de metadatos para recolectar el código X++.
 *
 * El recorrido es genérico y recursivo a propósito. Los métodos de un
 * formulario no viven en un solo lugar: están en el artefacto, en sus orígenes
 * de datos, en los campos de cada origen y en los controles. Un lector que solo
 * mire el nivel raíz descarta los demás en silencio, que es la peor forma de
 * fallar: el archivo generado parece correcto.
 *
 * Al no enumerar las rutas de antemano, el recorrido tampoco se rompe con tipos
 * de artefacto que todavía no hayamos visto.
 */

import type { ContainerKind, ContainerUnit, MethodUnit, SourceUnit } from './types';

/** Interfaz mínima de DOM que necesitamos. La cumple `@xmldom/xmldom`. */
export interface DomElement {
    nodeType: number;
    nodeName: string;
    localName?: string | null;
    textContent: string | null;
    childNodes: ArrayLike<DomElement>;
}

const ELEMENT_NODE = 1;

/** Envoltorios de colección conocidos y qué clase de contenedor agrupan. */
const COLLECTION_KINDS: Record<string, ContainerKind> = {
    DataSources: 'dataSource',
    Fields: 'dataField',
    DataControls: 'control',
    Controls: 'control',
    Members: 'unknown'
};

/** Nombre local de un elemento, ignorando el prefijo de espacio de nombres. */
export function tagOf(node: DomElement): string {
    const name = node.localName ?? node.nodeName;
    const colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
}

/** Hijos que son elementos, en orden de documento. */
export function childElements(node: DomElement): DomElement[] {
    const out: DomElement[] = [];
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === ELEMENT_NODE) {
            out.push(child);
        }
    }
    return out;
}

/** Primer hijo directo con el nombre dado. */
export function childNamed(node: DomElement, tag: string): DomElement | undefined {
    return childElements(node).find((c) => tagOf(c) === tag);
}

/** Texto de un hijo directo, o `undefined` si no existe. */
function childText(node: DomElement, tag: string): string | undefined {
    const child = childNamed(node, tag);
    return child ? (child.textContent ?? '') : undefined;
}

/**
 * Normaliza el CDATA de un método.
 *
 * Los bloques `<Source>` vienen envueltos en saltos de línea y ya traen la
 * sangría que le corresponde a su nivel de anidamiento, así que solo se quitan
 * los saltos del borde. Recortar el inicio con `trimStart()` —o cualquier cosa
 * que toque espacios iniciales— destruiría esa sangría.
 */
export function normalizeSource(raw: string): string {
    return raw
        .replace(/\r\n?/g, '\n')
        .replace(/^\n+/, '')
        .replace(/\s+$/, '');
}

function readMethod(node: DomElement): MethodUnit | undefined {
    const source = childNamed(node, 'Source');
    if (!source) {
        // Los artefactos de build (`XppMetadata/`) traen elementos `Method` sin
        // `Source`: son firmas, no código. No son un error, simplemente no aportan.
        return undefined;
    }
    return {
        name: childText(node, 'Name')?.trim() ?? '',
        source: normalizeSource(source.textContent ?? '')
    };
}

/** Nombre de un contenedor: los campos se identifican por `DataField`, el resto por `Name`. */
function containerName(node: DomElement): string | undefined {
    const name = childText(node, 'Name')?.trim();
    if (name) {
        return name;
    }
    const dataField = childText(node, 'DataField')?.trim();
    return dataField || undefined;
}

/**
 * Recolecta métodos y contenedores bajo un nodo, en orden de documento.
 *
 * Distingue dos formas de elemento sin necesidad de una lista blanca:
 *
 * - **Contenedor**: tiene un `<Name>` o un `<DataField>` propio. Se convierte en
 *   una clase anidada en la salida (`DataSource`, `Field`, `Control`).
 * - **Envoltorio**: no tiene nombre propio; solo agrupa hijos. Se atraviesa sin
 *   generar nada (`DataSources`, `Fields`, `DataControls`).
 */
function collect(
    node: DomElement,
    kindHint: ContainerKind,
    methods: MethodUnit[],
    containers: ContainerUnit[]
): void {
    for (const child of childElements(node)) {
        const tag = tagOf(child);

        if (tag === 'Methods') {
            for (const methodNode of childElements(child)) {
                if (tagOf(methodNode) !== 'Method') {
                    continue;
                }
                const method = readMethod(methodNode);
                if (method) {
                    methods.push(method);
                }
            }
            continue;
        }

        // `Declaration` y `UnparsableSource` los lee el nivel raíz, no el recorrido.
        if (tag === 'Declaration' || tag === 'UnparsableSource' || tag === 'Name') {
            continue;
        }

        const collectionKind = COLLECTION_KINDS[tag];
        const name = containerName(child);

        if (name === undefined) {
            // Envoltorio: atravesar propagando la clase que anuncia la colección.
            collect(child, collectionKind ?? kindHint, methods, containers);
            continue;
        }

        // Contenedor con nombre propio: abre una clase anidada.
        const unit: ContainerUnit = {
            kind: kindHint,
            name,
            controlType: childText(child, 'Type')?.trim() || undefined,
            methods: [],
            containers: []
        };
        collect(child, kindHint, unit.methods, unit.containers);

        // Un contenedor sin nada dentro no aporta código y no se emite.
        if (unit.methods.length > 0 || unit.containers.length > 0) {
            containers.push(unit);
        }
    }
}

/**
 * Construye el árbol de código a partir del elemento `<SourceCode>` de un artefacto.
 *
 * Importante: se espera el `SourceCode` que es hijo *directo* de la raíz. Un
 * `AxDataEntityView` lleva además un `ViewMetadata/SourceCode` que corresponde a
 * la consulta embebida (`[Query] class Metadata extends QueryRun`), una unidad
 * de compilación distinta que no pertenece a la clase de la entidad.
 */
export function buildSourceUnit(sourceCode: DomElement): SourceUnit {
    const unit: SourceUnit = { methods: [], containers: [] };

    const unparsable = childNamed(sourceCode, 'UnparsableSource');
    if (unparsable && (unparsable.textContent ?? '').trim()) {
        unit.unparsableSource = normalizeSource(unparsable.textContent ?? '');
        return unit;
    }

    const declaration = childNamed(sourceCode, 'Declaration');
    if (declaration && (declaration.textContent ?? '').trim()) {
        unit.declaration = normalizeSource(declaration.textContent ?? '');
    }

    collect(sourceCode, 'unknown', unit.methods, unit.containers);

    // Varios tipos —formularios y consultas entre ellos— no usan `<Declaration>`:
    // declaran la clase en un método llamado `classDeclaration`.
    const declIndex = unit.methods.findIndex((m) => m.name === 'classDeclaration');
    if (declIndex !== -1) {
        unit.classDeclaration = unit.methods[declIndex];
        unit.methods.splice(declIndex, 1);
    }

    return unit;
}
