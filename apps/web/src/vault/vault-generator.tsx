import * as React from "react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button.tsx";
import { CopyButton } from "./copy-button.tsx";
import {
  classNames,
  generatePassword,
  generatePassphrase,
  type CharacterClass,
} from "./generator.ts";

function useGenerator() {
  const [mode, setMode] = useState<"password" | "passphrase">("password");
  const [length, setLength] = useState(20);
  const [count, setCount] = useState(5);
  const [separator, setSeparator] = useState("-");
  const [classes, setClasses] = useState<CharacterClass[]>([
    "uppercase",
    "lowercase",
    "numbers",
    "symbols",
  ]);
  const [value, setValue] = useState("");
  const [estimate, setEstimate] = useState<{
    value: string;
    score: number | null;
  } | null>(null);
  const score = estimate?.value === value ? estimate.score : null;
  useEffect(() => {
    if (!value) return undefined;
    let current = true;
    void import("./strength.ts")
      .then(({ strength }) => {
        if (current) setEstimate({ value, score: strength(value) });
        return undefined;
      })
      .catch(() => {
        if (current) setEstimate({ value, score: null });
      });
    return () => {
      current = false;
    };
  }, [value]);
  function generate() {
    setValue(
      mode === "password"
        ? generatePassword(length, classes)
        : generatePassphrase(count, separator),
    );
  }
  return {
    mode,
    setMode,
    length,
    setLength,
    count,
    setCount,
    separator,
    setSeparator,
    classes,
    setClasses,
    value,
    setValue,
    estimate,
    score,
    generate,
  };
}

type GeneratorState = ReturnType<typeof useGenerator>;

export function Generator() {
  const state = useGenerator();
  const { mode, classes, length, count, generate } = state;
  return (
    <div className="content-wrap vault-content">
      <div className="page-breadcrumb">
        VAULT <span>/</span> GENERATOR
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">CREATE LOCALLY</p>
          <h1>Generator</h1>
          <p className="page-subtitle">
            Generate a password or passphrase on this device.
          </p>
        </div>
      </div>
      <section className="vault-card vault-generator">
        <GeneratorMode state={state} />
        <GeneratorOptions state={state} />
        <Button
          onClick={generate}
          disabled={
            mode === "password"
              ? classes.length === 0 ||
                !Number.isInteger(length) ||
                length < 8 ||
                length > 128
              : !Number.isInteger(count) || count < 3 || count > 12
          }
        >
          Generate
        </Button>
        <GeneratorResult state={state} />
        <p className="vault-note">
          Generated values stay in this page. Clipboard clearing after 30
          seconds is best effort when this page has focus.
        </p>
      </section>
    </div>
  );
}

function GeneratorMode({ state }: { state: GeneratorState }) {
  const { mode, setMode, setValue } = state;
  return (
    <>
      <fieldset>
        <legend>Type</legend>
        <div className="vault-options">
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "password"}
              onChange={() => {
                setMode("password");
                setValue("");
              }}
            />{" "}
            Password
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={mode === "passphrase"}
              onChange={() => {
                setMode("passphrase");
                setValue("");
              }}
            />{" "}
            Passphrase
          </label>
        </div>
      </fieldset>
    </>
  );
}

function GeneratorOptions({ state }: { state: GeneratorState }) {
  const { mode } = state;
  return (
    <>
      {mode === "password" ? (
        <PasswordOptions state={state} />
      ) : (
        <PassphraseOptions state={state} />
      )}
    </>
  );
}

function PasswordOptions({ state }: { state: GeneratorState }) {
  const { length, setLength, classes, setClasses } = state;
  return (
    <>
      <>
        <label className="vault-field">
          Length{" "}
          <input
            type="number"
            min={8}
            max={128}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
          />
        </label>
        <fieldset>
          <legend>Character classes</legend>
          <div className="vault-options">
            {classNames.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={classes.includes(name)}
                  onChange={(event) =>
                    setClasses(
                      event.target.checked
                        ? [...classes, name]
                        : classes.filter((item) => item !== name),
                    )
                  }
                />{" "}
                {name.charAt(0).toUpperCase() + name.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
      </>
    </>
  );
}

function PassphraseOptions({ state }: { state: GeneratorState }) {
  const { count, setCount, separator, setSeparator } = state;
  return (
    <>
      <>
        <label className="vault-field">
          Words{" "}
          <input
            type="number"
            min={3}
            max={12}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
        </label>
        <label className="vault-field">
          Separator{" "}
          <select
            value={separator}
            onChange={(event) => setSeparator(event.target.value)}
          >
            <option value="-">Hyphen</option>
            <option value=" ">Space</option>
            <option value=".">Period</option>
          </select>
        </label>
      </>
    </>
  );
}

function GeneratorResult({ state }: { state: GeneratorState }) {
  const { mode, value, estimate, score } = state;
  return (
    <>
      {value && (
        <div className="vault-result">
          <label htmlFor="vault-generated">Generated {mode}</label>
          <textarea
            id="vault-generated"
            value={value}
            readOnly
            rows={3}
            spellCheck={false}
          />
          <div className="vault-result-actions">
            <CopyButton value={value} clear label="Copy generated value" />
            <span>
              Strength:{" "}
              {score === null
                ? estimate?.value === value
                  ? "Unavailable"
                  : "Checking…"
                : ["Very weak", "Weak", "Fair", "Strong", "Very strong"][score]}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
