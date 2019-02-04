import { IElmIssue } from "./diagnosticsProvider";

import * as cp from "child_process";
import * as readline from "readline";
import * as utils from "../util/elmUtils";

import URI from "vscode-uri";

import {
    Diagnostic,
    DiagnosticSeverity,
    DidSaveTextDocumentParams,
    IConnection,
    PublishDiagnosticsParams,
    Range,
} from "vscode-languageserver";

export class ElmMakeDiagnostics {
    private connection: IConnection;
    private elmWorkspaceFolder: URI;

    constructor(connection: IConnection, elmWorkspaceFolder: URI) {
        this.connection = connection;
        this.elmWorkspaceFolder = elmWorkspaceFolder;
    }

    public createDiagnostics = async (param: DidSaveTextDocumentParams): Promise<PublishDiagnosticsParams[]> => {
        const uri: URI = URI.parse(param.textDocument.uri);
        const compileErrors: PublishDiagnosticsParams[] = [];

        const compilerErrors: IElmIssue[] = await this.checkForErrors(
            this.connection,
            this.elmWorkspaceFolder.fsPath,
            uri.fsPath,
        );

        const cwd: string = this.elmWorkspaceFolder.fsPath;
        const splitCompilerErrors: Map<string, IElmIssue[]> = new Map();

        compilerErrors.forEach((issue: IElmIssue) => {
            // If provided path is relative, make it absolute
            if (issue.file.startsWith(".")) {
                issue.file = cwd + issue.file.slice(1);
            }
            if (splitCompilerErrors.has(issue.file)) {
                splitCompilerErrors.get(issue.file).push(issue);
            } else {
                splitCompilerErrors.set(issue.file, [issue]);
            }
        });
        // Turn split arrays into diagnostics and associate them with correct files in VS
        splitCompilerErrors.forEach((issue: IElmIssue[], issuePath: string) => {
            compileErrors.push({
                diagnostics: issue.map((error) => this.elmMakeIssueToDiagnostic(error)),
                uri: URI.file(issuePath).toString(),
            });
        });
        return compileErrors;
    }

    private checkForErrors(
        connection: IConnection,
        rootPath: string,
        filename: string,
    ): Promise<IElmIssue[]> {
        return new Promise((resolve, reject) => {
            const makeCommand: string = "elm";
            const cwd: string = rootPath;
            let make: cp.ChildProcess;
            if (utils.isWindows) {
                filename = '"' + filename + '"';
            }
            const args = [
                "make",
                filename,
                "--report",
                "json",
                "--output",
                "/dev/null",
            ];
            if (utils.isWindows) {
                make = cp.exec(makeCommand + " " + args.join(" "), { cwd });
            } else {
                make = cp.spawn(makeCommand, args, { cwd });
            }
            // output is actually optional
            // (fixed in https://github.com/Microsoft/vscode/commit/b4917afe9bdee0e9e67f4094e764f6a72a997c70,
            // but unreleased at this time)
            const errorLinesFromElmMake: readline.ReadLine = readline.createInterface(
                {
                    input: make.stderr,
                    output: undefined,
                },
            );
            const lines: IElmIssue[] = [];
            errorLinesFromElmMake.on("line", (line: string) => {
                const errorObject = JSON.parse(line);

                if (errorObject.type === "compile-errors") {
                    errorObject.errors.forEach((error) => {
                        const problems = error.problems.map((problem) => ({
                            details: problem.message
                                .map(
                                    (message) =>
                                        typeof message === "string"
                                            ? message
                                            : "#" + message.string + "#",
                                )
                                .join(""),
                            file: error.path,
                            overview: problem.title,
                            region: problem.region,
                            subregion: "",
                            tag: "error",
                            type: "error",
                        }));

                        lines.push(...problems);
                    });
                } else if (errorObject.type === "error") {
                    const problem = {
                        details: errorObject.message
                            .map(
                                (message) => (typeof message === "string" ? message : message.string),
                            )
                            .join(""),
                        file: errorObject.path,
                        overview: errorObject.title,
                        region: {
                            end: {
                                column: 1,
                                line: 1,
                            },
                            start: {
                                column: 1,
                                line: 1,
                            },
                        },
                        subregion: "",
                        tag: "error",
                        type: "error",
                    };

                    lines.push(problem);
                }
            });
            make.on("error", (err: Error) => {
                errorLinesFromElmMake.close();
                if (err && (err as any).code === "ENOENT") {
                    connection.console.log(
                        "The 'elm make' compiler is not available.  Install Elm from http://elm-lang.org/.",
                    );
                    resolve([]);
                } else {
                    reject(err);
                }
            });
            make.on("close", (code: number, signal: string) => {
                errorLinesFromElmMake.close();

                resolve(lines);
            });
        });
    }

    private severityStringToDiagnosticSeverity(
        severity: string,
    ): DiagnosticSeverity {
        switch (severity) {
            case "error":
                return DiagnosticSeverity.Error;
            case "warning":
                return DiagnosticSeverity.Warning;
            default:
                return DiagnosticSeverity.Error;
        }
    }

    private elmMakeIssueToDiagnostic(issue: IElmIssue): Diagnostic {
        const lineRange: Range = Range.create(
            issue.region.start.line - 1,
            issue.region.start.column - 1,
            issue.region.end.line - 1,
            issue.region.end.column - 1,
        );
        return Diagnostic.create(
            lineRange,
            issue.overview + " - " + issue.details.replace(/\[\d+m/g, ""),
            this.severityStringToDiagnosticSeverity(issue.type),
            null,
            "Elm",
        );
    }
}