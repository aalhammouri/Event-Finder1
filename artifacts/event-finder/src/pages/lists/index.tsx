import { useState } from "react";
import { useLocation } from "wouter";
import {
  useGetUrlLists,
  useCreateUrlList,
  useRunUrlList,
  useDeleteUrlList,
  useUpdateUrlList,
  getGetUrlListsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Play, Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/errors";

export default function UrlLists() {
  const { data: lists, isLoading } = useGetUrlLists();
  const createList = useCreateUrlList();
  const runList = useRunUrlList();
  const deleteList = useDeleteUrlList();
  const updateList = useUpdateUrlList();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const handleCreate = () => {
    createList.mutate({ data: { name: "New List", urls: [] } }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getGetUrlListsQueryKey() });
        setLocation(`/lists/${res.id}`);
      },
      onError: (err) => {
        toast({
          title: "Couldn't create list",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      },
    });
  };

  const handleRun = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    runList.mutate({ id }, {
      onSuccess: (res) => {
        toast({ title: "Run started", description: "Crawling in progress…" });
        setLocation(`/runs/${res.id}`);
      },
      onError: (err) => {
        toast({
          title: "Couldn't start run",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      },
    });
  };

  const openEdit = (e: React.MouseEvent, id: number, name: string) => {
    e.stopPropagation();
    setEditId(id);
    setEditName(name);
  };

  const confirmEdit = () => {
    if (!editId || !editName.trim()) return;
    updateList.mutate({ id: editId, data: { name: editName.trim() } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetUrlListsQueryKey() });
        toast({ title: "List renamed" });
        setEditId(null);
      },
      onError: (err) => {
        toast({
          title: "Couldn't rename list",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      },
    });
  };

  const openDelete = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setDeleteId(id);
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteList.mutate({ id: deleteId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetUrlListsQueryKey() });
        toast({ title: "List deleted" });
        setDeleteId(null);
      },
      onError: (err) => {
        toast({
          title: "Couldn't delete list",
          description: getErrorMessage(err),
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">URL Lists</h1>
        <Button onClick={handleCreate} disabled={createList.isPending}>
          <Plus className="w-4 h-4 mr-2" /> New List
        </Button>
      </div>

      <div className="bg-card rounded-md border shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URLs</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead className="text-right pr-4">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Loading…</TableCell>
              </TableRow>
            ) : lists?.length ? (
              lists.map((list) => (
                <TableRow
                  key={list.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setLocation(`/lists/${list.id}`)}
                >
                  <TableCell className="font-medium">{list.name}</TableCell>
                  <TableCell>{list.urlCount}</TableCell>
                  <TableCell>{list.lastRunAt ? new Date(list.lastRunAt).toLocaleString() : "Never"}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={(e) => handleRun(e, list.id)} title="Run crawl">
                        <Play className="w-4 h-4 text-[#214292]" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={(e) => openEdit(e, list.id, list.name)} title="Rename">
                        <Pencil className="w-4 h-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={(e) => openDelete(e, list.id)} title="Delete">
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No lists created yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Rename dialog */}
      <Dialog open={editId !== null} onOpenChange={(open) => { if (!open) setEditId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename List</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="list-name">List name</Label>
            <Input
              id="list-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmEdit()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
            <Button onClick={confirmEdit} disabled={updateList.isPending || !editName.trim()}>
              {updateList.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this list?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the URL list and all its entries. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={confirmDelete}
              disabled={deleteList.isPending}
            >
              {deleteList.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
