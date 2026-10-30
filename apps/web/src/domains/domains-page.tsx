import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { DomainName } from "@opensuite/contracts";
import { Button } from "../ui/button.tsx";
import { TextField } from "../ui/text-field.tsx";
import { domainsClient } from "./client.ts";

export function DomainsPage() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: () => domainsClient.list({}),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["domains"] });
  const add = useMutation({
    mutationFn: (value: string) => domainsClient.add({ name: value }),
    onSuccess: async () => {
      setName("");
      setMessage("Domain added. Publish the records below.");
      await refresh();
    },
    onError: async () => {
      setMessage(
        "Domain setup did not finish. Check the list and reconcile any partial setup before retrying.",
      );
      await refresh();
    },
  });
  const recheck = useMutation({
    mutationFn: (domainId: string) => domainsClient.recheck({ domainId }),
    onSuccess: async () => {
      setMessage("DNS check completed.");
      await refresh();
    },
    onError: () => setMessage("Unable to check this domain."),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = DomainName.safeParse(name);
    if (!parsed.success) {
      setMessage("Enter a valid domain name.");
      return;
    }
    add.mutate(parsed.data);
  }
  return (
    <div className="content-wrap">
      <div className="page-breadcrumb">
        WORKSPACE <span>/</span> DOMAINS
      </div>
      <div className="page-header">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h1>Domains</h1>
          <p className="page-subtitle">
            Manage mail domains and check their DNS records.
          </p>
        </div>
      </div>
      <section className="dependency-card">
        <h2>Add a domain</h2>
        <p>DNS changes are made at your DNS provider.</p>
        <form onSubmit={submit}>
          <TextField
            label="Domain name"
            placeholder="example.com"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="dialog-actions">
            <Button type="submit" disabled={add.isPending}>
              Add domain
            </Button>
          </div>
        </form>
      </section>
      <output>{message}</output>
      {domains.isPending && <p>Loading domains…</p>}
      {domains.isError && (
        <p role="alert">
          Unable to load domains. Administrator access is required.
        </p>
      )}
      {domains.data?.length === 0 && <p>No domains added yet.</p>}
      {domains.data?.map((domain) => (
        <section className="dependency-card domain-card" key={domain.id}>
          <div className="section-heading">
            <div>
              <h2>{domain.name}</h2>
              <p>
                Status: {domain.status}
                {domain.checkedAt
                  ? ` · Checked ${new Date(domain.checkedAt).toLocaleString()}`
                  : " · Not checked yet"}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate(domain.id)}
            >
              Recheck DNS
            </Button>
          </div>
          <p>
            Copy these records to your DNS provider. Merge SPF with any existing
            SPF policy.
          </p>
          <div className="domain-records">
            {domain.records.map((record) => (
              <article
                className="domain-record"
                key={`${record.type}-${record.name}-${record.value}`}
              >
                <div>
                  <strong>{record.type}</strong> · {record.status}
                  {record.priority === undefined
                    ? ""
                    : ` · Priority ${record.priority}`}
                </div>
                <div>
                  <span>Name: </span>
                  <code>{record.name}</code>
                </div>
                <div>
                  <span>Value: </span>
                  <code>{record.value}</code>
                </div>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(record.name).then(
                      () => setMessage("Record name copied."),
                      () =>
                        setMessage("Copy failed. Select the name to copy it."),
                    );
                  }}
                >
                  Copy name for {record.name}
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(record.value).then(
                      () => setMessage("Record value copied."),
                      () =>
                        setMessage("Copy failed. Select the value to copy it."),
                    );
                  }}
                >
                  Copy value for {record.name}
                </Button>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
