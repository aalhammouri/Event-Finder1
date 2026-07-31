import { useParams, useLocation } from "wouter";
import { useGetUrlList, useUpdateUrlList, useRunUrlList, getGetUrlListQueryKey, getGetUrlListsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Play, Save, ArrowLeft } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errors";
import { parseUrlTextarea } from "@/lib/urls";

export default function UrlListDetail() {
  const { id } = useParams();
  const listId = Number(id);
  const { data: list, isLoading } = useGetUrlList(listId, { query: { enabled: !!listId, queryKey: getGetUrlListQueryKey(listId) } });
  const updateList = useUpdateUrlList();
  const runList = useRunUrlList();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");

  useEffect(() => {
    if (list) {
      setName(list.name);
      setUrls(list.urls.join("\n"));
    }
  }, [list]);

  const handleSave = () => {
    updateList.mutate({
      id: listId,
      data: {
        name,
        // Clean up paste noise (wrapping quotes, missing scheme, blank lines)
        // before sending; the server normalizes again and is the source of
        // truth for what gets stored.
        urls: parseUrlTextarea(urls)
      }
    }, {
      onSuccess: () => {
        toast({ title: "Saved successfully" });
        // Refetch so the textarea shows exactly the normalized URLs that were
        // stored, rather than the raw text the user typed.
        queryClient.invalidateQueries({ queryKey: getGetUrlListQueryKey(listId) });
        queryClient.invalidateQueries({ queryKey: getGetUrlListsQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Couldn't save changes",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      }
    });
  };

  const handleRun = () => {
    runList.mutate({ id: listId }, {
      onSuccess: (res) => {
        toast({ title: "Run started" });
        setLocation(`/runs/${res.id}`);
      },
      onError: (err) => {
        toast({
          title: "Couldn't start run",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      }
    });
  };

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation('/lists')}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-3xl font-bold tracking-tight flex-1">Edit List</h1>
        <Button onClick={handleRun} variant="secondary">
          <Play className="w-4 h-4 mr-2" /> Run Now
        </Button>
        <Button onClick={handleSave} disabled={updateList.isPending}>
          <Save className="w-4 h-4 mr-2" /> Save Changes
        </Button>
      </div>

      <div className="space-y-4 bg-card p-6 rounded-md shadow-sm border">
        <div>
          <label className="text-sm font-medium mb-1 block">List Name</label>
          <Input value={name} onChange={e => setName(e.target.value)} className="max-w-md" />
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">URLs (one per line)</label>
          <Textarea 
            value={urls} 
            onChange={e => setUrls(e.target.value)} 
            rows={15}
            className="font-mono text-sm"
          />
        </div>
      </div>
    </div>
  );
}
