/**
 * Vendored from XppSourceViewer (https://github.com/JonatanTorino/XppSourceViewer),
 * Copyright (c) 2026 Jonatan Torino, MIT License (see THIRD-PARTY-NOTICES).
 * Kept verbatim (including Spanish comments) to ease syncing upstream.
 */

/**
 * Modelo de datos del transpilador de metadatos D365FO a X++.
 *
 * El transpilador es deliberadamente independiente de la API de VS Code: no
 * importa `vscode` en ningún punto, de modo que puede ejecutarse y testearse
 * bajo Node a secas.
 */

/** Tipos de artefacto de metadatos que llevan código X++ embebido. */
export const SOURCE_BEARING_KINDS = [
    'AxClass',
    'AxTable',
    'AxForm',
    'AxQuery',
    'AxView',
    'AxDataEntityView',
    'AxMap',
    'AxCompositeDataEntityView',
    'AxAggregateDataEntity'
] as const;

export type ArtifactKind = (typeof SOURCE_BEARING_KINDS)[number] | string;

/**
 * Clase de contenedor anidado dentro de `SourceCode`.
 *
 * D365FO serializa los métodos de un formulario en varios niveles —el propio
 * formulario, sus orígenes de datos, los campos de cada origen y los controles—
 * y el editor de Visual Studio los presenta como clases anidadas decoradas con
 * un atributo. `ContainerKind` es esa decoración.
 */
export type ContainerKind = 'dataSource' | 'dataField' | 'control' | 'unknown';

/** Un método X++ con su código fuente tal como venía en el CDATA. */
export interface MethodUnit {
    name: string;
    /** CDATA con saltos de línea normalizados a `\n` y sin líneas en blanco al borde. */
    source: string;
}

/** Un contenedor anidado (origen de datos, campo o control) con sus métodos. */
export interface ContainerUnit {
    kind: ContainerKind;
    name: string;
    /** Tipo del control, presente solo para `kind === 'control'`. */
    controlType?: string;
    methods: MethodUnit[];
    containers: ContainerUnit[];
}

/** El árbol de código de un artefacto, antes de emitirse como texto. */
export interface SourceUnit {
    /** Contenido de `<Declaration>`, si el artefacto lo usa. */
    declaration?: string;
    /** Método `classDeclaration`, que ciertos tipos usan en vez de `<Declaration>`. */
    classDeclaration?: MethodUnit;
    /** Métodos del nivel raíz del artefacto. */
    methods: MethodUnit[];
    /** Contenedores anidados, en orden de documento. */
    containers: ContainerUnit[];
    /** Código que D365FO no pudo parsear y serializó tal cual. */
    unparsableSource?: string;
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface TranspileDiagnostic {
    severity: DiagnosticSeverity;
    message: string;
}

export interface TranspileResult {
    /** Nombre del elemento raíz del XML, p. ej. `AxClass`. */
    kind: ArtifactKind;
    /** Nombre del artefacto, del elemento `<Name>` de la raíz. */
    name: string;
    /** El código X++ reconstruido. Cadena vacía si el artefacto no lleva código. */
    xpp: string;
    /** Total de métodos emitidos, incluidos los de contenedores anidados. */
    methodCount: number;
    /** True si el artefacto no tiene ningún código X++ (p. ej. una tabla de staging). */
    empty: boolean;
    /** True si el código venía en `<UnparsableSource>` y se emitió sin procesar. */
    unparsable: boolean;
    diagnostics: TranspileDiagnostic[];
}

export interface TranspileOptions {
    /** Fin de línea del texto emitido. Por defecto `crlf`, que es lo que usa D365FO. */
    eol?: 'crlf' | 'lf';
    /**
     * Quitar los comentarios de documentación `///`.
     *
     * Los artefactos de D365FO suelen traer un bloque `/// <summary>` por método
     * que repite el nombre del método y poco más. Para leer de corrido, estorban.
     */
    stripDocComments?: boolean;
    /** Anteponer una cabecera con el tipo, el nombre y la cantidad de métodos. */
    headerComment?: boolean;
    /** Texto de procedencia para la cabecera, normalmente la ruta del XML. */
    sourceLabel?: string;
}
