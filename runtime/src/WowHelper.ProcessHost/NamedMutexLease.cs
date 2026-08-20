namespace WowHelper.ProcessHost;

internal sealed class NamedMutexLease : IDisposable
{
    private readonly Mutex mutex;
    private bool acquired;

    private NamedMutexLease(Mutex mutex, bool acquired)
    {
        this.mutex = mutex;
        this.acquired = acquired;
    }

    internal static NamedMutexLease? TryAcquire(string name)
    {
        var mutex = new Mutex(false, $"Local\\WowHelper.ProcessHost.Mutex.{name}");
        try
        {
            var acquired = false;
            try
            {
                acquired = mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                acquired = true;
            }
            return acquired ? new(mutex, true) : DisposeAndReturnNull(mutex);
        }
        catch
        {
            mutex.Dispose();
            throw;
        }
    }

    private static NamedMutexLease? DisposeAndReturnNull(Mutex mutex)
    {
        mutex.Dispose();
        return null;
    }

    public void Dispose()
    {
        if (acquired)
        {
            mutex.ReleaseMutex();
            acquired = false;
        }
        mutex.Dispose();
    }
}
